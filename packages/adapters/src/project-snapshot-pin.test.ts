import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectSnapshotPin } from "./project-snapshot-pin";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
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
});
