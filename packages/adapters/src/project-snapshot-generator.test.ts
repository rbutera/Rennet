import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyInventory,
  isSnapshotFresh,
  materializeSnapshot,
  querySymbolIndex,
  serializeManifest,
  verifySnapshotIntegrity,
} from "@rennet/core";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION, sha256Hex } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import {
  listTreeLineCounts,
  matchesGlob,
  parseWorkspaceGlobs,
  readTreeLineCounts,
} from "./project-snapshot-source";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    expect(manifest.schemaVersion).toBe(PROJECT_SNAPSHOT_SCHEMA_VERSION);

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

    // Four PATHS carry a structural-facts shard (pnpm-workspace.yaml, package.json,
    // and the three sources), but only FOUR DISTINCT BLOBS exist among them — the
    // copy shares `z-orig.ts`'s blob, so it shares its shard pointer rather than
    // adding a fifth.
    expect(full.manifest.symbols).toHaveLength(4);
    expect(step2.manifest.symbols).toHaveLength(4);
    expect(new Set(full.manifest.symbols.map(([blobOid]) => blobOid)).size).toBe(4);
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect(step2.manifest.fingerprint).toBe(full.manifest.fingerprint);
    const fullShards = new Map(full.built.shards);
    expect([...step2.built.shards.keys()].sort()).toEqual([...fullShards.keys()].sort());
    for (const [d, b] of step2.built.shards) expect(b).toBe(fullShards.get(d));
  }, 60000);

  it("classifies the WHOLE inventory by banner: a generated .py is excluded, its hand-written sibling is not", async () => {
    const { root, storeDir } = bareRepo();
    write(root, "packages/p/src/keep.ts", "export const keep = 0;\n");
    // Neither `.py` matches any PATH rule (`_pb2.py`, `.generated.`, `dist/`, …), so
    // the banner is the ONLY thing that can tell them apart — which is precisely the
    // evidence a TS/JS-only symbol shard could never carry.
    write(root, "packages/p/src/schema_pb.py", "# @generated by protoc. DO NOT EDIT.\nX = 1\n");
    write(root, "packages/p/src/hand.py", "# hand written, by a person\nY = 2\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const oid1 = git(root, "rev-parse", "HEAD");

    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    const first = await generator.generate(root, { explicitBaseRef: oid1 });
    const materialized = materializeSnapshot(first.manifest, (d) => first.built.shards.get(d));
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const symbols = querySymbolIndex(materialized.snapshot);
    const mapped = classifyInventory(
      materialized.snapshot.files,
      symbols.ok ? symbols.index.generatedBlobs : new Set(),
    )
      .filter((entry) => entry.ineligible === null)
      .map((entry) => entry.path);
    expect(mapped).toContain("packages/p/src/hand.py");
    expect(mapped).toContain("packages/p/src/keep.ts");
    expect(mapped).not.toContain("packages/p/src/schema_pb.py");

    // An UNCHANGED non-TS blob reuses its shard verbatim on the next baseline…
    write(root, "packages/p/src/keep.ts", "export const keep = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const oid2 = git(root, "rev-parse", "HEAD");
    const second = await generator.generate(root, { explicitBaseRef: oid2 });
    expect(second.extractedSymbolShards).toBe(1);
    expect(second.reusedSymbolShards).toBe(first.manifest.symbols.length - 1);

    // …and the incremental result is still BYTE-IDENTICAL to a clean full build.
    const clean = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
      previousSymbols: [],
      previousReferences: [],
      previousImports: [],
    });
    expect(serializeManifest(second.manifest)).toBe(serializeManifest(clean.manifest));
    const cleanShards = new Map(clean.built.shards);
    expect([...second.built.shards.keys()].sort()).toEqual([...cleanShards.keys()].sort());
    for (const [digest, bytes] of second.built.shards) expect(bytes).toBe(cleanShards.get(digest));
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

describe("ProjectSnapshotGenerator — the generated-banner flag rides the single blob read", () => {
  // The one mapping-eligibility signal that is NOT a function of the path (W2). It
  // is derived where the generator already reads each blob's text, so it inherits
  // the family's content-addressed reuse rather than adding a second pass.

  function bannerRepo(): { root: string; storeDir: string } {
    const root = mkdtempSync(join(tmpdir(), "rennet-gen-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-genstore-"));
    scratch.push(root, storeDir);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(root, "packages/p/package.json", JSON.stringify({ name: "@t/p", private: true }));
    // A generated file with NO path signal: it sits in `src/` under an ordinary
    // name, so only its banner can betray it.
    write(
      root,
      "packages/p/src/api-client.ts",
      "// Code generated by openapi-gen. DO NOT EDIT.\nexport const call = 1;\n",
    );
    write(root, "packages/p/src/hand-written.ts", "export const written = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    return { root, storeDir };
  }

  async function shardsByPath(
    result: Awaited<ReturnType<ProjectSnapshotGenerator["generate"]>>,
  ): Promise<Map<string, { generated: boolean }>> {
    const filesShard = JSON.parse(
      result.built.shards.get(result.manifest.shards.files.digest) as string,
    ) as { entries: { path: string; blobOid: string }[] };
    const byBlob = new Map(result.manifest.symbols);
    const out = new Map<string, { generated: boolean }>();
    for (const entry of filesShard.entries) {
      const digest = byBlob.get(entry.blobOid);
      if (digest === undefined) continue;
      out.set(
        entry.path,
        JSON.parse(result.built.shards.get(digest) as string) as { generated: boolean },
      );
    }
    return out;
  }

  it("stamps a banner-carrying blob generated, and an ordinary one not", async () => {
    const { root } = bannerRepo();
    const built = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: git(root, "rev-parse", "HEAD"),
      previousSymbols: [],
    });
    const byPath = await shardsByPath(built);
    expect(byPath.get("packages/p/src/api-client.ts")?.generated).toBe(true);
    // The positive control: the same build, same extractor, ordinary file ⇒ false.
    expect(byPath.get("packages/p/src/hand-written.ts")?.generated).toBe(false);
  }, 60000);

  it("carries the flag through an incremental rebuild, byte-identically to a clean one", async () => {
    const { root, storeDir } = bannerRepo();
    const oid1 = git(root, "rev-parse", "HEAD");
    // Touch only the hand-written file, so the generated blob is REUSED, not re-read.
    write(root, "packages/p/src/hand-written.ts", "export const written = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const oid2 = git(root, "rev-parse", "HEAD");

    const inc = new ProjectSnapshotGenerator({ store: new ProjectSnapshotStore(storeDir) });
    await inc.generate(root, { explicitBaseRef: oid1 });
    const step2 = await inc.generate(root, { explicitBaseRef: oid2 });
    const full = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
      previousSymbols: [],
    });

    expect(step2.extractedSymbolShards).toBe(1);
    expect(step2.reusedSymbolShards).toBeGreaterThanOrEqual(1);
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect((await shardsByPath(step2)).get("packages/p/src/api-client.ts")?.generated).toBe(true);
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
    expect(manifest.schemaVersion).toBe(PROJECT_SNAPSHOT_SCHEMA_VERSION);
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

describe("ProjectSnapshotGenerator — live build progress", () => {
  it("emits the real stages in order with concrete details, and reports the file count", async () => {
    const { root, oid2, storeDir } = workspaceRepo();
    const store = new ProjectSnapshotStore(storeDir);
    const events: { stage: string; note: string; detail?: string }[] = [];
    const result = await new ProjectSnapshotGenerator({ store }).generate(root, {
      explicitBaseRef: oid2,
      onProgress: (progress) => events.push({ ...progress }),
    });

    // Every stage the generator actually performs fired, in build order.
    const stages = events.map((event) => event.stage);
    for (const stage of [
      "resolve",
      "tree",
      "workspace",
      "conventions",
      "symbols",
      "build",
      "verify",
      "store",
    ]) {
      expect(stages).toContain(stage);
    }
    expect(stages.indexOf("resolve")).toBeLessThan(stages.indexOf("tree"));
    expect(stages.indexOf("tree")).toBeLessThan(stages.indexOf("symbols"));
    expect(stages.indexOf("build")).toBeLessThan(stages.indexOf("verify"));
    expect(stages.indexOf("verify")).toBeLessThan(stages.indexOf("store"));

    // The narration carries real, specific detail — not scripted text.
    const tree = events.find((event) => event.stage === "tree" && event.detail);
    expect(tree?.detail).toMatch(/^\d+ files?$/);
    const resolve = events.find((event) => event.stage === "resolve" && event.detail);
    expect(resolve?.detail).toBeTruthy();

    // The reported file count matches the tree the snapshot was built over.
    expect(result.fileCount).toBeGreaterThan(0);
    expect(tree?.detail).toBe(`${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}`);
  }, 180000);

  it("emits no store stage when no store is configured (nothing is persisted)", async () => {
    const { root, oid2 } = workspaceRepo();
    const stages: string[] = [];
    await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid2,
      previousSymbols: [],
      onProgress: (progress) => stages.push(progress.stage),
    });
    expect(stages).toContain("build");
    expect(stages).not.toContain("store");
  }, 180000);
});

describe("ProjectSnapshotGenerator — real symbol/reference totals (not shard counts)", () => {
  function singleFileRepo(source: string): { root: string; oid: string } {
    const root = mkdtempSync(join(tmpdir(), "rennet-onefile-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "package.json", JSON.stringify({ name: "one", private: true }));
    write(root, "src/index.ts", source);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    return { root, oid: git(root, "rev-parse", "HEAD") };
  }

  it("sums declared symbols across a shard instead of counting the per-blob pointer", async () => {
    // One source file → ONE symbol shard pointer, but THREE declared symbols. The
    // old bug reported `manifest.symbols.length` (= 1) as the symbol count.
    const { root, oid } = singleFileRepo(
      "export const one = 1;\nexport function two() {}\nexport class Three {}\n",
    );
    const result = await new ProjectSnapshotGenerator().generate(root, {
      explicitBaseRef: oid,
      previousSymbols: [],
      previousReferences: [],
    });
    // Two per-blob pointers (`src/index.ts` and `package.json`, which carries no
    // symbols but does carry its banner bit), and THREE declared symbols.
    expect(result.manifest.symbols.length).toBe(2);
    expect(result.symbolCount).toBe(3);
    // References are identifier OCCURRENCES, so with a repeated identifier the total
    // exceeds the per-blob reference-shard pointer count (= 1 here).
    expect(result.manifest.references.length).toBe(1);
    expect(result.referenceCount).toBeGreaterThan(1);
  }, 180000);
});

// -- listTreeLineCounts -- the whole-tree citation inventory (W5) -------------
// Board lint resolves a drafter's citation against every text file at the review
// commit, not only the changed ones, so this must answer for the WHOLE tree -- and
// its line counts must be the file's real length, not the extent of any diff.

describe("listTreeLineCounts", () => {
  function repoWith(files: Record<string, string>): { root: string; oid: string } {
    const root = mkdtempSync(join(tmpdir(), "rennet-linecounts-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    for (const [path, content] of Object.entries(files)) write(root, path, content);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    return { root, oid: git(root, "rev-parse", "HEAD") };
  }

  it("counts every text file in the tree, and skips binaries", async () => {
    const { root, oid } = repoWith({
      "src/a.ts": "one\ntwo\nthree\n",
      "src/deep/b.md": "# t\n\nbody\nmore\n",
      "src/no-trailing.txt": "x\ny",
      "assets/blob.bin": "\u0000\u0001binary\u0000",
    });
    const counts = await listTreeLineCounts(root, oid);
    expect(counts.get("src/a.ts")).toBe(3);
    expect(counts.get("src/deep/b.md")).toBe(4);
    // A missing final newline still leaves two lines.
    expect(counts.get("src/no-trailing.txt")).toBe(2);
    // Binaries carry no citable lines, so they are absent rather than wrong.
    expect(counts.has("assets/blob.bin")).toBe(false);
  }, 30000);

  it("parses a path containing a colon (the `-z` record separator earns its keep)", async () => {
    const { root, oid } = repoWith({ "src/we:ird.ts": "a\nb\nc\nd\n" });
    expect((await listTreeLineCounts(root, oid)).get("src/we:ird.ts")).toBe(4);
  }, 30000);

  // W5 finding 4 — git writes the path RAW between the `:` and the NUL, so a path
  // containing a newline used to garble its own record AND swallow the next one:
  // records were split on `\n`, which is not the separator git actually used.
  it("parses a path containing a NEWLINE, and does not lose the record after it", async () => {
    const { root, oid } = repoWith({
      "src/we\nird.ts": "a\nb\nc\nd\n",
      "src/zz-after.ts": "x\ny\n",
    });
    const counts = await listTreeLineCounts(root, oid);
    expect(counts.get("src/we\nird.ts")).toBe(4);
    expect(counts.get("src/zz-after.ts")).toBe(2);
  }, 30000);
});

// -- readTreeLineCounts -- head and base, SETTLED (W5 finding 3) --------------
// The two reads are independent. `Promise.all` discarded a perfectly good head
// inventory whenever the base read failed, degrading BOTH sides to the diff; the
// whole point of this PR is that partial knowledge beats none.

describe("readTreeLineCounts", () => {
  function repoWithTwoCommits(): { root: string; head: string; base: string } {
    const root = mkdtempSync(join(tmpdir(), "rennet-treecounts-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "src/a.ts", "one\ntwo\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    write(root, "src/a.ts", "one\ntwo\nthree\nfour\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "head");
    return { root, head: git(root, "rev-parse", "HEAD"), base };
  }

  it("reads both sides at their own commits", async () => {
    const { root, head, base } = repoWithTwoCommits();
    const inv = await readTreeLineCounts(root, head, base);
    expect(inv.head.get("src/a.ts")).toBe(4);
    expect(inv.base.get("src/a.ts")).toBe(2);
  }, 30000);

  it("KEEPS the side that answered when the other read fails", async () => {
    const { root, head, base } = repoWithTwoCommits();
    // A base oid git cannot resolve — the head read is untouched and must survive.
    const inv = await readTreeLineCounts(root, head, `${"0".repeat(40)}`);
    expect(inv.head.get("src/a.ts")).toBe(4);
    expect(inv.base.size).toBe(0);
    // ...and symmetrically, a broken head does not cost us the base.
    const flipped = await readTreeLineCounts(root, `${"0".repeat(40)}`, base);
    expect(flipped.head.size).toBe(0);
    expect(flipped.base.get("src/a.ts")).toBe(2);
  }, 30000);
});
