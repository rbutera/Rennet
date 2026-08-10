import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSnapshotFresh, serializeManifest, verifySnapshotIntegrity } from "@rennet/core";
import { sha256Hex } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { matchesGlob, parseWorkspaceGlobs } from "./project-snapshot-source";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** A workspace repo with two commits on `main` (OID1 then OID2). */
function workspaceRepo(): { root: string; oid1: string; oid2: string; storeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-snapshot-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-snapstore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");

  write(
    root,
    "pnpm-workspace.yaml",
    'packages:\n  - "packages/*"\n  - "apps/*"\n\nnodeLinker: hoisted\n',
  );
  write(root, "biome.json", '{ "formatter": { "enabled": true } }\n');
  write(root, "CODEOWNERS", "* @team/maintainers\npackages/a/** @team/a-owners\n");

  write(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@t/a", private: true, main: "./src/index.ts" }),
  );
  write(
    root,
    "packages/a/project.json",
    JSON.stringify({
      name: "t-a",
      sourceRoot: "packages/a/src",
      projectType: "library",
      tags: ["scope:t"],
    }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  write(root, "packages/a/src/index.test.ts", "import { a } from './index';\n");

  write(
    root,
    "packages/b/package.json",
    JSON.stringify({
      name: "@t/b",
      private: true,
      main: "./src/index.ts",
      dependencies: { "@t/a": "workspace:*" },
    }),
  );
  write(
    root,
    "packages/b/project.json",
    JSON.stringify({
      name: "t-b",
      projectType: "library",
      tags: ["scope:t"],
      implicitDependencies: ["t-a"],
    }),
  );
  write(root, "packages/b/src/index.ts", "export class B {}\nexport type BT = number;\n");

  write(
    root,
    "apps/app/package.json",
    JSON.stringify({ name: "@t/app", private: true, bin: { app: "./bin/app.js" } }),
  );
  write(root, "apps/app/src/main.ts", "export default function main() {}\n");
  write(root, "README.md", "# t\n");

  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const oid1 = git(root, "rev-parse", "HEAD");

  // OID2: change ONE existing file, ADD one new file. Everything else keeps its
  // blob (so its symbol shard is reused verbatim on the incremental build).
  write(
    root,
    "packages/b/src/index.ts",
    "export class B {}\nexport type BT = string;\nexport const NEW = 2;\n",
  );
  write(root, "packages/a/src/added.ts", "export const added = true;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "two");
  const oid2 = git(root, "rev-parse", "HEAD");

  return { root, oid1, oid2, storeDir };
}

describe("ProjectSnapshotGenerator — end-to-end over a real git repo", () => {
  it("incremental rebuild of the changed closure is BYTE-IDENTICAL to a clean full build", async () => {
    const { root, oid1, oid2, storeDir } = workspaceRepo();

    // Incremental path: build at OID1 (persist), then at OID2 (reuse OID1's
    // symbol shards for unchanged blobs, extract only the changed closure).
    const store = new ProjectSnapshotStore(storeDir);
    const incremental = new ProjectSnapshotGenerator({ store });
    await incremental.generate(root, { explicitBaseRef: oid1 });
    const step2 = await incremental.generate(root, { explicitBaseRef: oid2 });

    // Clean full path: a fresh generator, no prior symbols, straight at OID2.
    const full = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
      previousSymbols: [],
    });

    // The load-bearing property.
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect(step2.manifest.fingerprint).toBe(full.manifest.fingerprint);

    const fullShards = new Map(full.built.shards);
    const incShards = new Map(step2.built.shards);
    expect([...incShards.keys()].sort()).toEqual([...fullShards.keys()].sort());
    for (const [digest, bytes] of incShards) expect(bytes).toBe(fullShards.get(digest));

    // And it genuinely was incremental: b/src/index.ts changed and a/src/added.ts
    // is new (2 extracted); a/src/index.ts and app/src/main.ts blobs are
    // unchanged, so they are reused, not re-extracted.
    expect(step2.extractedSymbolShards).toBe(2);
    expect(step2.reusedSymbolShards).toBeGreaterThanOrEqual(2);
  });

  it("pins to the OID and captures workspace scopes, edges, entry points, tests, ownership", async () => {
    const { root, oid2 } = workspaceRepo();
    const { manifest, built } = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
    });

    expect(manifest.baseOid).toBe(oid2);
    expect(manifest.schemaVersion).toBe(1);

    const scopes = JSON.parse(built.shards.get(manifest.shards.scopes.digest) ?? "{}");
    const names = scopes.entries.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["@t/a", "@t/app", "@t/b"]);

    const edges = JSON.parse(built.shards.get(manifest.shards.edges.digest) ?? "{}");
    // @t/b → @t/a via a manifest dep AND an implicit (project.json) dep.
    expect(edges.entries).toEqual(
      expect.arrayContaining([
        { from: "@t/b", to: "@t/a", kind: "manifest" },
        { from: "@t/b", to: "@t/a", kind: "implicit" },
      ]),
    );

    const tests = JSON.parse(built.shards.get(manifest.shards.tests.digest) ?? "{}");
    expect(tests.entries.map((t: { path: string }) => t.path)).toEqual([
      "packages/a/src/index.test.ts",
    ]);

    const ownership = JSON.parse(built.shards.get(manifest.shards.ownership.digest) ?? "{}");
    expect(ownership.entries).toEqual([
      { pattern: "*", owners: ["@team/maintainers"] },
      { pattern: "packages/a/**", owners: ["@team/a-owners"] },
    ]);

    const conventions = JSON.parse(built.shards.get(manifest.shards.conventions.digest) ?? "{}");
    const conventionPaths = conventions.entries.map((c: { path: string }) => c.path).sort();
    expect(conventionPaths).toContain("biome.json");
    expect(conventionPaths).toContain("pnpm-workspace.yaml");
  });

  it("persists atomically and the stored snapshot passes the staleness + integrity gate", async () => {
    const { root, oid2, storeDir } = workspaceRepo();
    const store = new ProjectSnapshotStore(storeDir);
    const result = await new ProjectSnapshotGenerator({ store }).generate(root, {
      explicitBaseRef: oid2,
    });
    const repoKey = result.manifest.repoKey;

    const loaded = store.loadManifest(repoKey);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    // Fresh only at the pinned OID.
    expect(isSnapshotFresh(loaded, oid2)).toBe(true);
    expect(isSnapshotFresh(loaded, "deadbeef")).toBe(false);

    // Every referenced shard is present and intact through the store loader.
    const intact = verifySnapshotIntegrity(loaded, (digest) => store.loadShard(repoKey, digest));
    expect(intact.ok).toBe(true);

    // Corrupt one stored shard on disk → the gate fails closed.
    const scopeDigest = loaded.shards.scopes.digest;
    const shardPath = findShardPath(storeDir, scopeDigest);
    writeFileSync(shardPath, `${readFileSync(shardPath, "utf8")} tampered`);
    const corrupted = verifySnapshotIntegrity(loaded, (digest) => store.loadShard(repoKey, digest));
    expect(corrupted.ok).toBe(false);
    expect(corrupted.mismatched).toContain(scopeDigest);
  });

  it("fails closed when the default branch cannot be resolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-noref-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "r@e.test");
    git(root, "config", "user.name", "R");
    write(root, "a.txt", "hi\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    // No origin/HEAD, no upstream, no explicit ref → throw, never guess.
    await expect(new ProjectSnapshotGenerator().generate(root)).rejects.toThrow(
      /could not resolve/,
    );
  });
});

/** Locate a content-addressed shard file under a store base dir, by digest. */
function findShardPath(storeDir: string, digest: string): string {
  for (const repo of readdirSync(storeDir)) {
    // Local-first layout (design §1.1): <escaped-path>/map/shards/<digest>.json.
    const candidate = join(storeDir, repo, "map", "shards", `${digest}.json`);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(`shard ${digest} not found under ${storeDir}`);
}

describe("parseWorkspaceGlobs / matchesGlob — against the real workspace file", () => {
  it("reads the packages block from the real rennet pnpm-workspace.yaml", () => {
    const yaml = readFileSync(join(import.meta.dirname, "../../../pnpm-workspace.yaml"), "utf8");
    const globs = parseWorkspaceGlobs(yaml);
    expect(globs).toContain("apps/*");
    expect(globs).toContain("packages/*");
  });

  it("ignores non-package keys and inline comments", () => {
    const globs = parseWorkspaceGlobs(
      'packages:\n  - "packages/*" # the libs\n  - apps/*\nnodeLinker: hoisted\n',
    );
    expect(globs).toEqual(["packages/*", "apps/*"]);
  });

  it("matches single-segment and any-depth globs", () => {
    expect(matchesGlob("packages/*", "packages/core")).toBe(true);
    expect(matchesGlob("packages/*", "packages/core/src")).toBe(false);
    expect(matchesGlob("packages/**", "packages/core/src")).toBe(true);
    expect(matchesGlob("apps/*", "packages/core")).toBe(false);
    // A literal `.` in a glob is escaped, not treated as "any char".
    expect(matchesGlob("libs/a.b", "libs/a.b")).toBe(true);
    expect(matchesGlob("libs/a.b", "libs/axb")).toBe(false);
  });
});

describe("ProjectSnapshotGenerator — rename & same-content copy through the real git source", () => {
  // CONTROLLED fixtures, and this is a deliberate documented fallback: rennet's
  // own git history has NO eligible-source (.ts/.js) rename or same-content copy
  // — only a single `.md` rename and some config/yaml/json copies, none of which
  // produce symbol shards — so a synthetic .ts rename/copy is the only way to
  // drive the blocker through the real git → core → store pipeline. The airtight
  // byte-level proof lives in the core package's PURE tests; these exercise the
  // same property end-to-end over actual git plumbing.

  function bareRepo(): { root: string; storeDir: string } {
    const root = mkdtempSync(join(tmpdir(), "rennet-rc-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-rcstore-"));
    scratch.push(root, storeDir);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(root, "packages/p/package.json", JSON.stringify({ name: "@t/p", private: true }));
    return { root, storeDir };
  }

  it("a pure RENAME (same blob, new path) is byte-identical incremental vs clean full build", async () => {
    const { root, storeDir } = bareRepo();
    write(root, "packages/p/src/mod-a.ts", "export const x = 1;\nexport function f() {}\n");
    write(root, "packages/p/src/keep.ts", "export const keep = 0;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const oid1 = git(root, "rev-parse", "HEAD");

    git(root, "mv", "packages/p/src/mod-a.ts", "packages/p/src/mod-b.ts");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "rename mod-a to mod-b");
    const oid2 = git(root, "rev-parse", "HEAD");
    // Confirm git sees it as a byte-identical rename (R100).
    expect(git(root, "diff", "--name-status", "-M100%", oid1, oid2)).toMatch(/^R100\t/m);

    const store = new ProjectSnapshotStore(storeDir);
    const inc = new ProjectSnapshotGenerator({ store });
    await inc.generate(root, { explicitBaseRef: oid1 });
    const step2 = await inc.generate(root, { explicitBaseRef: oid2 });
    const full = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
      previousSymbols: [],
    });

    // The moved blob was reused (its content never changed), so any divergence
    // would be purely the path-in-shard bug.
    expect(step2.reusedSymbolShards).toBeGreaterThanOrEqual(1);
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect(step2.manifest.fingerprint).toBe(full.manifest.fingerprint);
    const fullShards = new Map(full.built.shards);
    expect([...step2.built.shards.keys()].sort()).toEqual([...fullShards.keys()].sort());
    for (const [d, b] of step2.built.shards) expect(b).toBe(fullShards.get(d));
  }, 60000);

  it("a same-content COPY (two paths, one blob) is byte-identical incremental vs clean full build", async () => {
    const { root, storeDir } = bareRepo();
    // oid1: the blob lives at a LATE-sorting path only.
    write(root, "packages/p/src/z-orig.ts", "export const dup = 2;\n");
    write(root, "packages/p/src/keep.ts", "export const keep = 0;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const oid1 = git(root, "rev-parse", "HEAD");

    // oid2: copy the SAME content to an EARLY-sorting path, keep the original.
    write(root, "packages/p/src/a-copy.ts", "export const dup = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "copy dup to a-copy");
    const oid2 = git(root, "rev-parse", "HEAD");

    const store = new ProjectSnapshotStore(storeDir);
    const inc = new ProjectSnapshotGenerator({ store });
    await inc.generate(root, { explicitBaseRef: oid1 });
    const step2 = await inc.generate(root, { explicitBaseRef: oid2 });
    const full = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
      previousSymbols: [],
    });

    // dup + keep ⇒ two symbol entries; the shared blob is ONE entry in each.
    expect(full.manifest.symbols).toHaveLength(2);
    expect(step2.manifest.symbols).toHaveLength(2);
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect(step2.manifest.fingerprint).toBe(full.manifest.fingerprint);
    const fullShards = new Map(full.built.shards);
    expect([...step2.built.shards.keys()].sort()).toEqual([...fullShards.keys()].sort());
    for (const [d, b] of step2.built.shards) expect(b).toBe(fullShards.get(d));
  }, 60000);

  it("advance REWRITES a pre-existing but truncated shard rather than trusting existsSync (#2)", async () => {
    const { root } = workspaceRepo();
    const oid2 = git(root, "rev-parse", "HEAD");
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-advstore-"));
    scratch.push(storeDir);

    // Build WITHOUT a store to get the BuiltSnapshot, then plant a truncated copy
    // of one shard on disk — exactly what a non-atomic writeFileSync + crash
    // leaves behind — before advancing.
    const built = (
      await new ProjectSnapshotGenerator().generate(root, {
        explicitBaseRef: oid2,
        previousSymbols: [],
      })
    ).built;
    const repoKey = built.manifest.repoKey;
    const first = [...built.shards][0];
    expect(first).toBeDefined();
    if (!first) return;
    const [digest, goodBytes] = first;
    // Local-first layout (design §1.1): <baseDir>/<escaped-path>/map/shards/ —
    // the escaped repoKey is used directly as the dir name (no sha256Hex hashing).
    const shardsDir = join(storeDir, repoKey, "map", "shards");
    mkdirSync(shardsDir, { recursive: true });
    const shardFile = join(shardsDir, `${digest}.json`);
    writeFileSync(shardFile, goodBytes.slice(0, Math.max(1, goodBytes.length - 5)));
    // The planted file EXISTS but does NOT hash to its digest.
    expect(sha256Hex(readFileSync(shardFile, "utf8"))).not.toBe(digest);

    new ProjectSnapshotStore(storeDir).advance(built);

    // Advance verified the on-disk bytes and rewrote the corrupt shard.
    const after = readFileSync(shardFile, "utf8");
    expect(after).toBe(goodBytes);
    expect(sha256Hex(after)).toBe(digest);

    // And the published snapshot passes the integrity gate through the store.
    const store = new ProjectSnapshotStore(storeDir);
    const loaded = store.loadManifest(repoKey);
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(verifySnapshotIntegrity(loaded, (d) => store.loadShard(repoKey, d)).ok).toBe(true);
  }, 60000);
});

describe("ProjectSnapshotGenerator — dogfood over the REAL rennet repo", () => {
  const repoRoot = join(import.meta.dirname, "../../..");
  function realGit(...args: string[]): string {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  }

  it("generates a clean, integral, fresh full snapshot at the resolved default branch (main)", async () => {
    const mainOid = realGit("rev-parse", "main");
    const { manifest, built } = await new ProjectSnapshotGenerator().generate(repoRoot, {
      explicitBaseRef: "main",
      previousSymbols: [],
    });

    expect(manifest.baseOid).toBe(mainOid);
    expect(manifest.schemaVersion).toBe(1);
    // Self-consistent: every referenced shard is present and hashes back.
    expect(verifySnapshotIntegrity(manifest, (d) => built.shards.get(d)).ok).toBe(true);
    expect(isSnapshotFresh(manifest, mainOid)).toBe(true);
    // It really mapped the real source tree: many eligible files ⇒ many shards.
    expect(manifest.symbols.length).toBeGreaterThan(50);
  }, 180000);

  it("incremental rebuild === clean full build over a real recent commit range from rennet's own history", async () => {
    const oid2 = realGit("rev-parse", "HEAD");
    const oid1 = realGit("rev-parse", "HEAD~1");
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-dogfood-"));
    scratch.push(storeDir);

    const store = new ProjectSnapshotStore(storeDir);
    const inc = new ProjectSnapshotGenerator({ store });
    await inc.generate(repoRoot, { explicitBaseRef: oid1 });
    const step2 = await inc.generate(repoRoot, { explicitBaseRef: oid2 });
    const full = await new ProjectSnapshotGenerator().generate(repoRoot, {
      explicitBaseRef: oid2,
      previousSymbols: [],
    });

    // The load-bearing property, over the real repo.
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect(step2.manifest.fingerprint).toBe(full.manifest.fingerprint);
    const fullShards = new Map(full.built.shards);
    expect([...step2.built.shards.keys()].sort()).toEqual([...fullShards.keys()].sort());
    for (const [d, b] of step2.built.shards) expect(b).toBe(fullShards.get(d));
    // And it genuinely reused work: most blobs are unchanged across one commit.
    expect(step2.reusedSymbolShards).toBeGreaterThan(0);
  }, 180000);
});
