import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSnapshotFresh, serializeManifest, verifySnapshotIntegrity } from "@rennet/core";
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
    const candidate = join(storeDir, repo, "shards", `${digest}.json`);
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
