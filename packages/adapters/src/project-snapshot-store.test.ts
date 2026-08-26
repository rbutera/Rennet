import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshotManifest } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { resolveBaseRef } from "./project-snapshot-source";
import {
  defaultProjectsBaseDir,
  MANIFEST_RETENTION,
  ProjectSnapshotStore,
  snapshotStoreFor,
} from "./project-snapshot-store";

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
function initRepo(prefix: string): { root: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, oid: git(root, "rev-parse", "HEAD") };
}
async function generateInto(
  storeDir: string,
  root: string,
  oid: string,
): Promise<{ store: ProjectSnapshotStore; manifest: ProjectSnapshotManifest }> {
  const store = new ProjectSnapshotStore(storeDir);
  const { manifest } = await new ProjectSnapshotGenerator({ store }).generate(root, {
    explicitBaseRef: oid,
  });
  return { store, manifest };
}

describe("ProjectSnapshotStore — local-first layout (design §1.1)", () => {
  it("resolves the escaped-path layout: <baseDir>/<repoKey>/{config.json, map/{manifest.json, shards/}}", () => {
    const store = new ProjectSnapshotStore("/base");
    const paths = store.paths("-Users-rai-dev-rennet");
    // The store lives on the HOST filesystem (native separators): assert with `join`
    // so the expectation is win32-native on Windows and POSIX elsewhere.
    const dir = join("/base", "-Users-rai-dev-rennet");
    expect(paths.projectDir).toBe(dir);
    expect(paths.configPath).toBe(join(dir, "config.json"));
    expect(paths.mapDir).toBe(join(dir, "map"));
    expect(paths.manifestPath).toBe(join(dir, "map", "manifest.json"));
    expect(paths.manifestsDir).toBe(join(dir, "map", "manifests"));
    expect(paths.shardsDir).toBe(join(dir, "map", "shards"));
    // Reserved homes for later waves — resolved now, populated later.
    expect(paths.overlaysDir).toBe(join(dir, "overlays"));
    expect(paths.knowledgeDir).toBe(join(dir, "knowledge"));
  });

  it("uses the escaped repoKey directly as the dir name (no sha256Hex hashing)", () => {
    const store = new ProjectSnapshotStore("/base");
    // The dir segment is the literal escaped key — human-legible, not a hash.
    expect(store.paths("-a-b").projectDir).toBe(join("/base", "-a-b"));
  });

  it("writes a generated snapshot under map/ and reads it back", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-store-"));
    scratch.push(storeDir);
    const { root, oid } = initRepo("rennet-store-repo-");
    const { store, manifest } = await generateInto(storeDir, root, oid);

    expect(existsSync(store.paths(manifest.repoKey).manifestPath)).toBe(true);
    expect(existsSync(store.paths(manifest.repoKey).shardsDir)).toBe(true);
    const reloaded = store.loadManifest(manifest.repoKey);
    expect(reloaded?.fingerprint).toBe(manifest.fingerprint);
  });

  it("defaultProjectsBaseDir + snapshotStoreFor default to ~/.rennet/projects", () => {
    expect(defaultProjectsBaseDir().endsWith(join(".rennet", "projects"))).toBe(true);
    // snapshotStoreFor with an explicit base composes a store at that base.
    const s = snapshotStoreFor("/tmp/x");
    expect(s.paths("k").projectDir).toBe(join("/tmp/x", "k"));
  });
});

describe("ProjectSnapshotStore — OID-addressable manifests (#246)", () => {
  it("keeps an older pinned OID readable after an advance to a new OID (an advance ADDS, not replaces)", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-store-"));
    scratch.push(storeDir);
    const { root, oid } = initRepo("rennet-store-oid-");
    const { store, manifest } = await generateInto(storeDir, root, oid);
    const oidA = manifest.baseOid;
    const oidB = "b".repeat(40);

    store.advance({
      manifest: { ...manifest, baseOid: oidB, fingerprint: `fp-${oidB}` },
      shards: new Map(),
    });

    // BOTH the old pin and the new tip resolve — the eviction that used to fail the old
    // one closed to `stale` is gone.
    expect(store.loadManifestAt(manifest.repoKey, oidA)?.baseOid).toBe(oidA);
    expect(store.loadManifestAt(manifest.repoKey, oidB)?.baseOid).toBe(oidB);
    // The current pointer is the newest tip.
    expect(store.loadManifest(manifest.repoKey)?.baseOid).toBe(oidB);
  });

  it("bounds the per-OID manifests to MANIFEST_RETENTION, keeping the newest tip readable", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-store-"));
    scratch.push(storeDir);
    const { root, oid } = initRepo("rennet-store-evict-");
    const { store, manifest } = await generateInto(storeDir, root, oid);

    const oids = Array.from({ length: MANIFEST_RETENTION + 3 }, (_, i) =>
      i.toString(16).padStart(40, "0"),
    );
    for (const o of oids) {
      store.advance({
        manifest: { ...manifest, baseOid: o, fingerprint: `fp-${o}` },
        shards: new Map(),
      });
    }

    const manifestsDir = store.paths(manifest.repoKey).manifestsDir;
    const files = readdirSync(manifestsDir).filter((f) => f.endsWith(".json"));
    // Bounded: after writing MANIFEST_RETENTION + 3 (+ the original) manifests, the dir
    // never holds more than the retention window — pruning ran.
    expect(files.length).toBeLessThanOrEqual(MANIFEST_RETENTION);
    expect(files.length).toBeLessThan(oids.length + 1);
    // The newest tip is always readable (freshest per-OID file, and the current pointer
    // backs it regardless of pruning).
    const newest = oids.at(-1) as string;
    expect(store.loadManifestAt(manifest.repoKey, newest)?.baseOid).toBe(newest);
  });

  it("NEVER prunes the current tip's own per-OID manifest, even when it is the oldest on disk (#246 F1)", async () => {
    // The reviewer's bug: pruning sorted by mtime alone, so a tie (or the current tip
    // being oldest) could delete the current pointer's OWN per-OID file, which the
    // fallback then hid until one more advance recreated the eviction. We force the
    // STRONGEST version — the current tip is strictly the oldest file on disk — and
    // assert it survives, with the exact retained/evicted set. (Oldest subsumes tied.)
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-store-"));
    scratch.push(storeDir);
    const { root, oid } = initRepo("rennet-store-keepcur-");
    const { store, manifest } = await generateInto(storeDir, root, oid);
    const manifestsDir = store.paths(manifest.repoKey).manifestsDir;

    // Fill the window with RETENTION manifests at strictly-increasing FUTURE mtimes, so
    // batch[0] is the oldest future file and batch[last] the newest.
    const baseFuture = Date.now() / 1000 + 86_400;
    const batch = Array.from(
      { length: MANIFEST_RETENTION },
      (_, i) => `a${i.toString(16).padStart(39, "0")}`,
    );
    batch.forEach((o, i) => {
      const p = join(manifestsDir, `${o}.json`);
      writeFileSync(p, JSON.stringify({ ...manifest, baseOid: o, fingerprint: `fp-${o}` }));
      utimesSync(p, baseFuture + i, baseFuture + i);
    });

    // Advance to a brand-new current tip; its file is written "now" → the OLDEST on disk.
    const current = "f".repeat(40);
    store.advance({
      manifest: { ...manifest, baseOid: current, fingerprint: "fp-cur" },
      shards: new Map(),
    });

    const has = (name: string) => existsSync(join(manifestsDir, name));
    // The current tip survives despite being oldest; the original generate OID and the
    // oldest future file are the two evicted (RETENTION+2 on disk → RETENTION kept).
    expect(has(`${current}.json`)).toBe(true);
    expect(has(`${batch[MANIFEST_RETENTION - 1]}.json`)).toBe(true); // newest future kept
    expect(has(`${batch[0]}.json`)).toBe(false); // oldest future evicted
    expect(has(`${oid}.json`)).toBe(false); // original (now-mtime, non-current) evicted
    const files = readdirSync(manifestsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(MANIFEST_RETENTION);
    expect(files).toContain(`${current}.json`);
  });
});

describe("ProjectSnapshotStore — path-keying: two checkouts get DISTINCT entries (A.1)", () => {
  it("keys a worktree DISTINCTLY from its main checkout (top-level, not shared git-common-dir)", async () => {
    // The load-bearing behavioural change: wave-1 keyed by realpath(git-common-dir)
    // so a worktree SHARED the main repo's entry. The spec keys by the escaped
    // top-level PATH, so a worktree on a branch gets its OWN local-first entry.
    const { root, oid } = initRepo("rennet-wt-main-");
    const wt = mkdtempSync(join(tmpdir(), "rennet-wt-linked-"));
    rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // git worktree add wants a non-existent path
    git(root, "worktree", "add", "--detach", wt, oid);
    scratch.push(wt);

    const mainBase = await resolveBaseRef(root, { explicitBaseRef: oid });
    const wtBase = await resolveBaseRef(wt, { explicitBaseRef: oid });

    // Distinct paths → distinct escaped keys → distinct store entries.
    expect(wtBase.repoKey).not.toBe(mainBase.repoKey);
    // ...and each is stable for its own checkout.
    const mainAgain = await resolveBaseRef(root, { explicitBaseRef: oid });
    expect(mainAgain.repoKey).toBe(mainBase.repoKey);
  });

  it("two independent repos at different paths get distinct entries", async () => {
    const a = initRepo("rennet-repoA-");
    const b = initRepo("rennet-repoB-");
    const baseA = await resolveBaseRef(a.root, { explicitBaseRef: a.oid });
    const baseB = await resolveBaseRef(b.root, { explicitBaseRef: b.oid });
    expect(baseA.repoKey).not.toBe(baseB.repoKey);
  });
});

describe("ProjectSnapshotStore — config.json read/write (A.1)", () => {
  it("round-trips a config and defaults to version-only when absent", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-cfg-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);

    expect(store.loadConfig("-k")).toBeNull();
    expect(store.loadConfigOrDefault("-k")).toEqual({ version: 1 });

    store.saveConfig("-k", { version: 1, promoted: true, path: "/Users/rai/dev/rennet" });
    expect(store.loadConfig("-k")).toEqual({
      version: 1,
      promoted: true,
      path: "/Users/rai/dev/rennet",
    });
    // Persisted at <projectDir>/config.json.
    expect(existsSync(store.paths("-k").configPath)).toBe(true);
  });

  it("updateConfig read-modify-writes atomically", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-cfg2-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    const next = store.updateConfig("-k", (c) => ({ ...c, promoted: true }));
    expect(next.promoted).toBe(true);
    expect(store.loadConfig("-k")?.promoted).toBe(true);
  });

  it("updateConfig REFUSES a malformed config, throwing and leaving the bytes byte-identical (Rule 75, red-proof)", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-cfg5-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    const configPath = store.paths("-k").configPath;
    mkdirSync(join(configPath, ".."), { recursive: true });
    const before = '{ "version": 1, "promoted": tru'; // truncated, unparseable
    writeFileSync(configPath, before);

    // The read-modify-write over a fresh default would silently discard the bad
    // bytes; the guard turns that into a loud throw instead. (Delete the guard in
    // updateConfig → this test reddens: the file is overwritten with a default.)
    expect(() => store.updateConfig("-k", (c) => ({ ...c, promoted: true }))).toThrow(/malformed/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("a malformed config reads as null (fail-safe), never a throw", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-cfg3-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    const path = store.paths("-k").configPath;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(store.loadConfig("-k")).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("{ not json"); // untouched
  });

  it("loadConfigState distinguishes absent / ok / malformed, and rejects an invalid visibility", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-cfg4-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    const path = store.paths("-k").configPath;
    mkdirSync(join(path, ".."), { recursive: true });

    // Absent — no file yet.
    expect(store.loadConfigState("-k")).toEqual({ status: "absent", config: null });

    // OK — a valid config round-trips through the state reader.
    store.saveConfig("-k", { version: 1, visibility: "git-visible" });
    const ok = store.loadConfigState("-k");
    expect(ok.status).toBe("ok");
    expect(ok.config?.visibility).toBe("git-visible");

    // Malformed — unparseable JSON.
    writeFileSync(path, "{ broken");
    expect(store.loadConfigState("-k").status).toBe("malformed");

    // Malformed — well-formed JSON but an out-of-enum visibility (must NOT flow on
    // as a value; `loadConfig` folds it to null so the map read paths stay safe).
    writeFileSync(path, JSON.stringify({ version: 1, visibility: "bogus" }));
    expect(store.loadConfigState("-k").status).toBe("malformed");
    expect(store.loadConfig("-k")).toBeNull();
  });
});
