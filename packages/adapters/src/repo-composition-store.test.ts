import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScopeTree, composeRepo, composeWorkspace } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import { RepoCompositionStore } from "./repo-composition-store";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("RepoCompositionStore", () => {
  it("persists thin repo and workspace compositions at their app-owned paths", () => {
    const projects = mkdtempSync(join(tmpdir(), "rennet-compositions-"));
    const workspaces = mkdtempSync(join(tmpdir(), "rennet-workspaces-"));
    scratch.push(projects, workspaces);
    const store = new RepoCompositionStore(new ProjectSnapshotStore(projects), workspaces);
    const repo = composeRepo({
      repoRecordId: "repo",
      pinnedOid: "oid",
      projectSnapshotId: "snapshot",
      scopeTree: buildScopeTree("repo", []),
      submodules: [],
    });
    const workspace = composeWorkspace({
      workspaceId: "workspace",
      members: [
        {
          repoRecordId: "repo",
          pinnedOid: "oid",
          projectSnapshotId: "snapshot",
          compositionDigest: repo.contentDigest,
        },
      ],
      edges: [],
    });
    store.saveRepo(repo);
    store.saveWorkspace(workspace);
    expect(store.loadRepo("repo")).toEqual(repo);
    expect(store.loadWorkspace("workspace")).toEqual(workspace);
    expect(readFileSync(store.repoPath("repo"), "utf8")).not.toContain("knowledge");
  });
});
