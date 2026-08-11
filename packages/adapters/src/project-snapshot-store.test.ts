import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshotManifest } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { resolveBaseRef } from "./project-snapshot-source";
import {
  defaultProjectsBaseDir,
  ProjectSnapshotStore,
  snapshotStoreFor,
} from "./project-snapshot-store";

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
    expect(paths.projectDir).toBe("/base/-Users-rai-dev-rennet");
    expect(paths.configPath).toBe("/base/-Users-rai-dev-rennet/config.json");
    expect(paths.mapDir).toBe("/base/-Users-rai-dev-rennet/map");
    expect(paths.manifestPath).toBe("/base/-Users-rai-dev-rennet/map/manifest.json");
    expect(paths.shardsDir).toBe("/base/-Users-rai-dev-rennet/map/shards");
    // Reserved homes for later waves — resolved now, populated later.
    expect(paths.overlaysDir).toBe("/base/-Users-rai-dev-rennet/overlays");
    expect(paths.knowledgeDir).toBe("/base/-Users-rai-dev-rennet/knowledge");
  });

  it("uses the escaped repoKey directly as the dir name (no sha256Hex hashing)", () => {
    const store = new ProjectSnapshotStore("/base");
    // The dir segment is the literal escaped key — human-legible, not a hash.
    expect(store.paths("-a-b").projectDir).toBe("/base/-a-b");
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
    expect(s.paths("k").projectDir).toBe("/tmp/x/k");
  });
});

describe("ProjectSnapshotStore — path-keying: two checkouts get DISTINCT entries (A.1)", () => {
  it("keys a worktree DISTINCTLY from its main checkout (top-level, not shared git-common-dir)", async () => {
    // The load-bearing behavioural change: wave-1 keyed by realpath(git-common-dir)
    // so a worktree SHARED the main repo's entry. The spec keys by the escaped
    // top-level PATH, so a worktree on a branch gets its OWN local-first entry.
    const { root, oid } = initRepo("rennet-wt-main-");
    const wt = mkdtempSync(join(tmpdir(), "rennet-wt-linked-"));
    rmSync(wt, { recursive: true, force: true }); // git worktree add wants a non-existent path
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
