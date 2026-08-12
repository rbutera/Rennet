import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { NestedProjectContext } from "./nested-project-context";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import { RepoCompositionStore } from "./repo-composition-store";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

describe("NestedProjectContext", () => {
  it("discloses an absent child while continuing to serve the current parent map", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-nested-context-"));
    const projects = mkdtempSync(join(tmpdir(), "rennet-nested-projects-"));
    const workspaces = mkdtempSync(join(tmpdir(), "rennet-nested-workspaces-"));
    scratch.push(root, projects, workspaces);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    write(root, "package.json", '{"name":"parent"}\n');
    write(root, "src/index.ts", "export const parent = true;\n");
    write(
      root,
      ".gitmodules",
      '[submodule "missing"]\n\tpath = vendor/missing\n\turl = ../missing\n',
    );
    git(root, "add", "-A");
    const childOid = "1234567890123456789012345678901234567890";
    git(root, "update-index", "--add", "--cacheinfo", `160000,${childOid},vendor/missing`);
    git(root, "commit", "-q", "-m", "parent");
    const oid = git(root, "rev-parse", "HEAD");
    const snapshots = new ProjectSnapshotStore(projects);
    const generated = await new ProjectSnapshotGenerator({ store: snapshots }).generate(root, {
      explicitBaseRef: oid,
    });
    const repoKey = escapePath(realpathSync(root));
    expect(generated.manifest.repoKey).toBe(repoKey);
    const nested = new NestedProjectContext(
      snapshots,
      new RepoCompositionStore(snapshots, workspaces),
    );
    const composition = await nested.composeRepo(root, repoKey, oid);

    expect(composition.freshness.status).toBe("stale");
    expect(nested.manifest(composition).members).toEqual([
      expect.objectContaining({ status: "absent", path: "vendor/missing", pinnedOid: childOid }),
    ]);
    const parentMap = nested.readMap({ repoRecordId: repoKey, pinnedOid: oid });
    expect(parentMap.ok).toBe(true);
    if (parentMap.ok)
      expect(parentMap.map.files.some((file) => file.path === "src/index.ts")).toBe(true);
    const deepMap = nested.readMap({ repoRecordId: repoKey, pinnedOid: oid }, { path: "src" });
    expect(deepMap.ok).toBe(true);
    if (parentMap.ok && deepMap.ok) {
      expect(deepMap.map.fingerprint).toBe(parentMap.map.fingerprint);
      expect(deepMap.map.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    }
    const workspace = nested.composeWorkspace("workspace", [composition], []);
    expect(workspace.freshness.status).toBe("stale");
    expect(workspace.freshness.staleMembers[0]?.path).toBe(`${repoKey}/vendor/missing`);
    expect(JSON.stringify(workspace)).not.toContain("knowledge");
  });

  it("pins a checked-out child at the parent gitlink through the existing overlay path", async () => {
    const childSource = mkdtempSync(join(tmpdir(), "rennet-nested-child-source-"));
    const parent = mkdtempSync(join(tmpdir(), "rennet-nested-parent-"));
    const projects = mkdtempSync(join(tmpdir(), "rennet-nested-overlay-projects-"));
    const workspaces = mkdtempSync(join(tmpdir(), "rennet-nested-overlay-workspaces-"));
    scratch.push(childSource, parent, projects, workspaces);
    git(childSource, "init", "-q", "-b", "main");
    git(childSource, "config", "user.email", "rennet@example.test");
    git(childSource, "config", "user.name", "Rennet Test");
    write(childSource, "package.json", '{"name":"child"}\n');
    write(childSource, "src/index.ts", "export const version = 1;\n");
    git(childSource, "add", "-A");
    git(childSource, "commit", "-q", "-m", "child A");
    const oidA = git(childSource, "rev-parse", "HEAD");
    write(childSource, "src/index.ts", "export const version = 2;\n");
    git(childSource, "add", "-A");
    git(childSource, "commit", "-q", "-m", "child B");
    const oidB = git(childSource, "rev-parse", "HEAD");

    git(parent, "init", "-q", "-b", "main");
    git(parent, "config", "user.email", "rennet@example.test");
    git(parent, "config", "user.name", "Rennet Test");
    write(parent, "package.json", '{"name":"parent"}\n');
    git(
      parent,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      childSource,
      "vendor/tool",
    );
    git(parent, "update-index", "--cacheinfo", `160000,${oidA},vendor/tool`);
    git(parent, "add", ".gitmodules", "package.json");
    git(parent, "commit", "-q", "-m", "parent pins A");
    const parentOid = git(parent, "rev-parse", "HEAD");
    expect(git(join(parent, "vendor/tool"), "rev-parse", "HEAD")).toBe(oidB);

    const snapshots = new ProjectSnapshotStore(projects);
    const parentSnapshot = await new ProjectSnapshotGenerator({ store: snapshots }).generate(
      parent,
      { explicitBaseRef: parentOid },
    );
    const nested = new NestedProjectContext(
      snapshots,
      new RepoCompositionStore(snapshots, workspaces),
    );
    const composition = await nested.composeRepo(
      parent,
      parentSnapshot.manifest.repoKey,
      parentOid,
    );
    const member = composition.submodules[0];
    expect(member?.status).toBe("resolved");
    if (member?.status !== "resolved") throw new Error("expected resolved submodule");
    expect(member.reference.pinnedOid).toBe(oidA);
    expect(member.reference.projectSnapshotId).not.toBe(oidB);
    const childMap = nested.readMap({
      repoRecordId: member.reference.repoRecordId,
      pinnedOid: oidA,
    });
    expect(childMap.ok).toBe(true);
    if (childMap.ok) expect(childMap.map.baseOid).toBe(oidA);
  });
});
