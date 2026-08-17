import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ensureProjectSnapshotPin } from "./project-snapshot-pin";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

describe("ensureProjectSnapshotPin", () => {
  it("builds a missing default-base map and returns its capture-time identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-pin-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "rennet-pin-store-"));
    scratch.push(root, storeRoot);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "r@e.test");
    git(root, "config", "user.name", "R");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "initial");
    const oid = git(root, "rev-parse", "HEAD");
    const store = new ProjectSnapshotStore(storeRoot);

    const pin = await ensureProjectSnapshotPin(store, root, oid);
    const manifest = store.loadManifestAt(escapePath(realpathSync(root)), oid);
    expect(pin).toBe(manifest?.fingerprint);
    expect(pin.length).toBeGreaterThan(0);
  });

  it("replaces a legacy feature snapshot with a default-base plus overlay composite", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-pin-legacy-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "rennet-pin-store-"));
    scratch.push(root, storeRoot);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "r@e.test");
    git(root, "config", "user.name", "R");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "main");
    const mainOid = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/main", mainOid);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "index.ts"), "export const value = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "feature");
    const featureOid = git(root, "rev-parse", "HEAD");

    const store = new ProjectSnapshotStore(storeRoot);
    const generator = new ProjectSnapshotGenerator({ store });
    await generator.generate(root, { explicitBaseRef: mainOid });
    const legacy = await generator.generate(root, { explicitBaseRef: featureOid });
    expect(store.loadManifest(legacy.manifest.repoKey)?.baseOid).toBe(featureOid);

    const pin = await ensureProjectSnapshotPin(store, root, featureOid);
    expect(pin).not.toBe(legacy.manifest.fingerprint);
    expect(store.loadManifest(legacy.manifest.repoKey)?.baseOid).toBe(mainOid);
  });
});
