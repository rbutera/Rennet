import { describe, expect, it } from "vitest";
import { classifyGitlinkAdvances } from "./gitlink-novelty";
import {
  buildScopeTree,
  composeRepo,
  composeWorkspace,
  eagerScopeTree,
  evaluateCompositionFreshness,
} from "./repo-composition";

describe("nested Repo Map composition", () => {
  it("builds only declared scopes, merges provenance, and nests by nearest declared root", () => {
    const tree = buildScopeTree("repo", [
      { name: "app", root: "apps/app", provenance: "pnpm" },
      { name: "app-nx", root: "apps/app", provenance: "nx", dependencies: ["lib"] },
      { name: "feature", root: "apps/app/feature", provenance: "nx" },
      { name: "lib", root: "packages/lib", provenance: "cargo" },
    ]);
    expect(tree.nodes.map((node) => node.root)).toEqual([
      "",
      "apps/app",
      "apps/app/feature",
      "packages/lib",
    ]);
    expect(tree.nodes.find((node) => node.root === "apps/app")?.provenance).toEqual(["nx", "pnpm"]);
    expect(tree.nodes.find((node) => node.root === "apps/app/feature")?.parentId).toBe(
      tree.nodes.find((node) => node.root === "apps/app")?.id,
    );
    expect(eagerScopeTree(tree).nodes.map((node) => node.root)).toEqual([
      "",
      "apps/app",
      "packages/lib",
    ]);
  });

  it("hashes repository references and workspaces independently of discovery order", () => {
    const tree = buildScopeTree("parent", []);
    const children = [
      {
        status: "resolved" as const,
        path: "vendor/b",
        reference: {
          repoRecordId: "b",
          pinnedOid: "b1",
          projectSnapshotId: "bs",
          contentDigest: "bd",
        },
      },
      {
        status: "resolved" as const,
        path: "vendor/a",
        reference: {
          repoRecordId: "a",
          pinnedOid: "a1",
          projectSnapshotId: "as",
          contentDigest: "ad",
        },
      },
    ];
    const first = composeRepo({
      repoRecordId: "parent",
      pinnedOid: "p1",
      projectSnapshotId: "ps",
      scopeTree: tree,
      submodules: children,
    });
    const second = composeRepo({
      repoRecordId: "parent",
      pinnedOid: "p1",
      projectSnapshotId: "ps",
      scopeTree: tree,
      submodules: [...children].reverse(),
    });
    expect(first.contentDigest).toBe(second.contentDigest);
    expect(first.submodules.map((member) => member.path)).toEqual(["vendor/a", "vendor/b"]);
    expect(JSON.stringify(first)).not.toContain("statements");

    const members = [
      { repoRecordId: "b", pinnedOid: "b1", projectSnapshotId: "bs", compositionDigest: "bd" },
      { repoRecordId: "a", pinnedOid: "a1", projectSnapshotId: "as", compositionDigest: "ad" },
    ];
    const edges = [
      {
        sourceRepoRecordId: "b",
        sourceScopeId: "root",
        kind: "dependency" as const,
        destination: {
          repoRecordId: "a",
          pinnedOid: "a1",
          projectSnapshotId: "as",
          contentDigest: "ad",
        },
      },
    ];
    expect(composeWorkspace({ workspaceId: "w", members, edges }).contentDigest).toBe(
      composeWorkspace({
        workspaceId: "w",
        members: [...members].reverse(),
        edges: [...edges].reverse(),
      }).contentDigest,
    );
  });

  it("names recursive absent and mismatched members without invalidating a current parent", () => {
    const freshness = evaluateCompositionFreshness(true, [
      { path: "missing", repoRecordId: "m", expectedOid: "m1" },
      {
        path: "child",
        repoRecordId: "c",
        expectedOid: "c1",
        observedOid: "c1",
        freshness: {
          status: "stale",
          staleMembers: [
            {
              path: "grandchild",
              repoRecordId: "g",
              reason: "oid-mismatch",
              expectedOid: "g1",
              observedOid: "g2",
            },
          ],
        },
      },
    ]);
    expect(freshness.status).toBe("stale");
    expect(freshness.staleMembers.map((member) => member.path)).toEqual([
      "child/grandchild",
      "missing",
    ]);
  });

  it("emits one model-free gitlink advance at the parent pin", () => {
    const entries = classifyGitlinkAdvances(
      [{ path: "vendor/tool", oid: "a", repoRecordId: "tool" }],
      [{ path: "vendor/tool", oid: "b", repoRecordId: "tool" }],
      "snapshot",
      "parent-oid",
    );
    expect(entries).toEqual([
      expect.objectContaining({
        unit: expect.objectContaining({
          kind: "gitlink",
          path: "vendor/tool",
          oldOid: "a",
          newOid: "b",
        }),
        evidence: expect.objectContaining({
          snapshotFingerprint: "snapshot",
          baseOid: "parent-oid",
          match: expect.objectContaining({ kind: "gitlink-advance" }),
        }),
      }),
    ]);
  });
});
