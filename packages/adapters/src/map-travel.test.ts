import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshotManifest } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  committedMapDir,
  discoverCommittedMap,
  promoteMap,
  readMapFromDir,
  resolveMapSource,
  validateMap,
} from "./map-travel";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
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

async function setup(): Promise<{
  store: ProjectSnapshotStore;
  storeDir: string;
  root: string;
  oid: string;
  manifest: ProjectSnapshotManifest;
}> {
  const root = mkdtempSync(join(tmpdir(), "rennet-travel-repo-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-travel-store-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");
  const store = new ProjectSnapshotStore(storeDir);
  const { manifest } = await new ProjectSnapshotGenerator({ store }).generate(root, {
    explicitBaseRef: oid,
  });
  return { store, storeDir, root, oid, manifest };
}

describe("map-travel — promotion (A.3)", () => {
  it("default settings never write derived data into the repo", async () => {
    const { root } = await setup();
    // Generation wrote only to the local store; the repo has no committed map.
    expect(existsSync(committedMapDir(root))).toBe(false);
    expect(existsSync(join(root, ".rennet"))).toBe(false);
  });

  it("promoteMap writes a valid, re-discoverable committed map + records config.promoted", async () => {
    const { store, root, manifest } = await setup();
    const result = promoteMap(store, manifest.repoKey, root);
    expect(result.promoted).toBe(true);
    expect(result.committedMapDir).toBe(committedMapDir(root));

    const committed = readMapFromDir(committedMapDir(root));
    expect(committed).not.toBeNull();
    if (committed) expect(validateMap(committed)).toBe(true);
    expect(store.loadConfig(manifest.repoKey)?.promoted).toBe(true);
  });

  it("refuses to promote when there is no local map", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-travel-empty-"));
    const root = mkdtempSync(join(tmpdir(), "rennet-travel-emptyrepo-"));
    scratch.push(storeDir, root);
    const store = new ProjectSnapshotStore(storeDir);
    expect(promoteMap(store, "-nope", root)).toEqual({ promoted: false, reason: "no-local-map" });
  });
});

describe("map-travel — discovery + validation (A.4)", () => {
  it("discovers a committed map and SEEDS it into a different checkout (re-keyed, self-consistent)", async () => {
    const { store, root, manifest } = await setup();
    promoteMap(store, manifest.repoKey, root);

    // A DIFFERENT checkout of the same repo: a fresh empty local store keyed by a
    // different escaped path. Discovery must validate the committed map and seed a
    // re-keyed, fingerprint-consistent local copy the reader will serve.
    const otherStoreDir = mkdtempSync(join(tmpdir(), "rennet-travel-other-"));
    scratch.push(otherStoreDir);
    const otherStore = new ProjectSnapshotStore(otherStoreDir);
    const otherKey = "-Users-someone-else-rennet";

    const discovered = discoverCommittedMap(otherStore, otherKey, root);
    expect(discovered).toEqual({ found: true, valid: true, seeded: true });

    // The seeded local map is served fresh at the same base OID under the NEW key.
    const reader = new ProjectContextReader(otherStore);
    const gated = reader.loadFresh(otherKey, manifest.baseOid);
    expect(gated.ok).toBe(true);
  });

  it("ignores a corrupt committed map, never seeds it", async () => {
    const { store, root, manifest } = await setup();
    promoteMap(store, manifest.repoKey, root);

    // Tamper one committed shard so integrity fails.
    const shardsDir = join(committedMapDir(root), "shards");
    const firstShard = readdirSync(shardsDir)[0];
    expect(firstShard).toBeDefined();
    if (!firstShard) return;
    const shardFile = join(shardsDir, firstShard);
    writeFileSync(shardFile, `${readFileSync(shardFile, "utf8")} tampered`);

    const otherStoreDir = mkdtempSync(join(tmpdir(), "rennet-travel-corrupt-"));
    scratch.push(otherStoreDir);
    const otherStore = new ProjectSnapshotStore(otherStoreDir);
    const discovered = discoverCommittedMap(otherStore, "-k", root);
    expect(discovered).toEqual({ found: true, valid: false, seeded: false });
    expect(otherStore.loadManifest("-k")).toBeNull();
  });

  it("does not clobber an existing local map (local wins, §1.4)", async () => {
    const { store, root, manifest } = await setup();
    promoteMap(store, manifest.repoKey, root);
    // The SAME store already has a local map at this key → discovery does not seed.
    const discovered = discoverCommittedMap(store, manifest.repoKey, root);
    expect(discovered).toEqual({ found: true, valid: true, seeded: false });
  });
});

describe("map-travel — precedence (A.5)", () => {
  it("local first, then committed, then build", async () => {
    const { store, root, manifest } = await setup();

    // Local present → local.
    expect(resolveMapSource(store, manifest.repoKey, root)).toEqual({
      source: "local",
      seeded: false,
    });

    // Only committed present → committed (seeded).
    promoteMap(store, manifest.repoKey, root);
    const otherStoreDir = mkdtempSync(join(tmpdir(), "rennet-prec-"));
    scratch.push(otherStoreDir);
    const otherStore = new ProjectSnapshotStore(otherStoreDir);
    expect(resolveMapSource(otherStore, "-k", root)).toEqual({ source: "committed", seeded: true });

    // Neither present → build.
    const emptyRepo = mkdtempSync(join(tmpdir(), "rennet-prec-empty-"));
    const emptyStoreDir = mkdtempSync(join(tmpdir(), "rennet-prec-emptystore-"));
    scratch.push(emptyRepo, emptyStoreDir);
    expect(resolveMapSource(new ProjectSnapshotStore(emptyStoreDir), "-k", emptyRepo)).toEqual({
      source: "build",
      seeded: false,
    });
  });
});
