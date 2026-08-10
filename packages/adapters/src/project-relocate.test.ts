import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextReader } from "./project-context-reader";
import { addAlias, relocateProject, resolveProjectKey } from "./project-relocate";
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
async function localMap(): Promise<{
  store: ProjectSnapshotStore;
  repoKey: string;
  baseOid: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "rennet-reloc-repo-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-reloc-store-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const oid = git(root, "rev-parse", "HEAD");
  const store = new ProjectSnapshotStore(storeDir);
  const { manifest } = await new ProjectSnapshotGenerator({ store }).generate(root, {
    explicitBaseRef: oid,
  });
  return { store, repoKey: manifest.repoKey, baseOid: manifest.baseOid };
}

describe("relocateProject (A.6)", () => {
  it("moves the project dir WITHOUT reindexing and preserves a servable map", async () => {
    const { store, repoKey, baseOid } = await localMap();
    const newKey = "-Users-rai-moved-rennet";

    expect(relocateProject(store, repoKey, newKey, { newPath: "/Users/rai/moved/rennet" })).toEqual(
      {
        relocated: true,
      },
    );
    expect(existsSync(store.paths(repoKey).projectDir)).toBe(false);
    expect(existsSync(store.paths(newKey).projectDir)).toBe(true);

    // The carried map is still served fresh under the new key (its fingerprint is
    // self-consistent with the original build; the next generate re-stamps it).
    const gated = new ProjectContextReader(store).loadFresh(newKey, baseOid);
    expect(gated.ok).toBe(true);
    expect(store.loadConfig(newKey)?.relocatedFrom).toBe(repoKey);
    expect(store.loadConfig(newKey)?.path).toBe("/Users/rai/moved/rennet");
  });

  it("fails safe on a missing source or an occupied target", async () => {
    const { store, repoKey } = await localMap();
    expect(relocateProject(store, "-absent", "-x")).toEqual({
      relocated: false,
      reason: "source-missing",
    });
    // Relocating onto the live key (which exists) is refused, not an overwrite.
    expect(relocateProject(store, repoKey, repoKey).relocated).toBe(true); // no-op same-key
    store.saveConfig("-occupied", { version: 1 });
    expect(relocateProject(store, repoKey, "-occupied")).toEqual({
      relocated: false,
      reason: "target-exists",
    });
  });
});

describe("aliases (A.6)", () => {
  it("resolves an alias escaped path back to the canonical project key", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-alias-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    // A real project dir at the canonical key.
    store.saveConfig("-canonical", { version: 1 });
    addAlias(store, "-canonical", "-alias-one");

    expect(resolveProjectKey(store, "-canonical")).toBe("-canonical");
    expect(resolveProjectKey(store, "-alias-one")).toBe("-canonical");
    // An unknown key resolves to itself (a fresh project keys itself).
    expect(resolveProjectKey(store, "-unknown")).toBe("-unknown");
  });

  it("addAlias is idempotent", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-alias2-"));
    scratch.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    store.saveConfig("-c", { version: 1 });
    addAlias(store, "-c", "-a");
    addAlias(store, "-c", "-a");
    expect(store.loadConfig("-c")?.aliases).toEqual(["-a"]);
  });
});
