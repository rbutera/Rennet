import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  buildScopeTree,
  composeRepo,
  composeWorkspace,
  eagerScopeTree,
  escapePath,
  type ObservedCompositionMember,
  type ProjectMapResult,
  type ProjectMapScope,
} from "@rennet/core";
import type {
  ContextManifest,
  CrossRepoEdge,
  RepoComposition,
  RepoMapMember,
  WorkspaceContext,
} from "@rennet/types";
import { execaGit, type GitExec } from "./git-range-diff";
import { ProjectContextReader } from "./project-context-reader";
import { ensureProjectSnapshotPin } from "./project-snapshot-pin";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import { discoverGitlinks, discoverWorkspaceScopes } from "./repo-composition-discovery";
import type { RepoCompositionStore } from "./repo-composition-store";
import { SnapshotOverlayReader } from "./snapshot-overlay-generator";
import { SnapshotOverlayStore } from "./snapshot-overlay-store";

export class NestedProjectContext {
  private readonly reader: ProjectContextReader;
  private readonly overlays: SnapshotOverlayReader;

  constructor(
    private readonly snapshots: ProjectSnapshotStore,
    private readonly compositions: RepoCompositionStore,
    private readonly git: GitExec = execaGit,
  ) {
    this.overlays = new SnapshotOverlayReader({
      store: snapshots,
      overlayStore: new SnapshotOverlayStore(snapshots),
    });
    this.reader = new ProjectContextReader(snapshots, this.overlays);
  }

  async composeRepo(
    repoRoot: string,
    repoRecordId: string,
    pinnedOid: string,
  ): Promise<RepoComposition> {
    const manifest = this.snapshots.loadManifestAt(repoRecordId, pinnedOid);
    const merged = manifest ? null : this.overlays.resolveMerged(repoRecordId, pinnedOid);
    const projectSnapshotId =
      manifest?.fingerprint ?? (merged?.ok ? merged.projectSnapshotId : null);
    if (!projectSnapshotId) {
      throw new Error(`ProjectSnapshot unavailable for ${repoRecordId} at ${pinnedOid}`);
    }
    return this.composeRepoAt(
      repoRoot,
      repoRecordId,
      pinnedOid,
      projectSnapshotId,
      new Set<string>(),
    );
  }

  private async composeRepoAt(
    repoRoot: string,
    repoRecordId: string,
    pinnedOid: string,
    projectSnapshotId: string,
    ancestors: ReadonlySet<string>,
  ): Promise<RepoComposition> {
    const identity = `${repoRecordId}\0${pinnedOid}`;
    if (ancestors.has(identity)) {
      const existing = this.compositions.loadRepo(repoRecordId);
      if (existing) return existing;
    }
    const nextAncestors = new Set(ancestors).add(identity);
    const declarations = await discoverWorkspaceScopes(this.git, repoRoot, pinnedOid);
    const scopeTree = buildScopeTree(repoRecordId, declarations);
    const gitlinks = await discoverGitlinks(this.git, repoRoot, repoRecordId, pinnedOid);
    const submodules: RepoMapMember[] = [];
    const observedMembers: ObservedCompositionMember[] = [];
    for (const gitlink of gitlinks) {
      const childRoot = join(repoRoot, gitlink.path);
      if (!existsSync(childRoot)) {
        submodules.push({
          status: "absent",
          path: gitlink.path,
          repoRecordId: gitlink.repoRecordId,
          pinnedOid: gitlink.oid,
        });
        observedMembers.push({
          path: gitlink.path,
          repoRecordId: gitlink.repoRecordId,
          expectedOid: gitlink.oid,
        });
        continue;
      }
      const childRepoRecordId = escapePath(realpathSync(childRoot));
      try {
        const projectSnapshotId = await ensureProjectSnapshotPin(
          this.snapshots,
          childRoot,
          gitlink.oid,
          this.git,
        );
        const childComposition = await this.composeRepoAt(
          childRoot,
          childRepoRecordId,
          gitlink.oid,
          projectSnapshotId,
          nextAncestors,
        );
        observedMembers.push({
          path: gitlink.path,
          repoRecordId: childRepoRecordId,
          expectedOid: gitlink.oid,
          expectedDigest: childComposition.contentDigest,
          observedOid: gitlink.oid,
          observedDigest: childComposition.contentDigest,
          freshness: childComposition.freshness,
        });
        submodules.push({
          status: "resolved",
          path: gitlink.path,
          reference: {
            repoRecordId: childRepoRecordId,
            pinnedOid: gitlink.oid,
            projectSnapshotId,
            contentDigest: childComposition.contentDigest,
          },
        });
      } catch {
        submodules.push({
          status: "absent",
          path: gitlink.path,
          repoRecordId: childRepoRecordId,
          pinnedOid: gitlink.oid,
        });
        observedMembers.push({
          path: gitlink.path,
          repoRecordId: childRepoRecordId,
          expectedOid: gitlink.oid,
        });
      }
    }
    const composition = composeRepo({
      repoRecordId,
      pinnedOid,
      projectSnapshotId,
      scopeTree,
      submodules,
      observedMembers,
    });
    this.compositions.saveRepo(composition);
    return composition;
  }

  readMap(
    reference: { repoRecordId: string; pinnedOid: string },
    scope?: ProjectMapScope,
  ): ProjectMapResult {
    return this.reader.readProjectMap(reference.repoRecordId, reference.pinnedOid, scope);
  }

  eagerScopeTree(composition: RepoComposition) {
    return eagerScopeTree(composition.scopeTree);
  }

  manifest(composition: RepoComposition): ContextManifest {
    return {
      repoRecordId: composition.repoRecordId,
      projectSnapshotId: composition.projectSnapshotId,
      compositionDigest: composition.contentDigest,
      freshness: composition.freshness,
      members: composition.submodules,
    };
  }

  composeWorkspace(
    workspaceId: string,
    repositories: readonly RepoComposition[],
    edges: readonly CrossRepoEdge[],
  ): WorkspaceContext {
    const context = composeWorkspace({
      workspaceId,
      members: repositories.map((repo) => ({
        repoRecordId: repo.repoRecordId,
        pinnedOid: repo.pinnedOid,
        projectSnapshotId: repo.projectSnapshotId,
        compositionDigest: repo.contentDigest,
      })),
      edges,
      observedMembers: repositories.map((repo) => ({
        path: repo.repoRecordId,
        repoRecordId: repo.repoRecordId,
        expectedOid: repo.pinnedOid,
        expectedDigest: repo.contentDigest,
        observedOid: repo.pinnedOid,
        observedDigest: repo.contentDigest,
        freshness: repo.freshness,
      })),
    });
    this.compositions.saveWorkspace(context);
    return context;
  }
}
