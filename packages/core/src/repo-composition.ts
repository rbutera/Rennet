import { canonicalize, sha256Hex } from "@rennet/protocol";
import type {
  CompositionFreshness,
  CompositionStaleMember,
  CrossRepoEdge,
  RepoComposition,
  RepoMapMember,
  ScopeProvenance,
  ScopeTree,
  ScopeTreeNode,
  WorkspaceContext,
  WorkspaceMember,
} from "@rennet/types";

export interface ScopeDeclaration {
  readonly name: string;
  readonly root: string;
  readonly provenance: ScopeProvenance;
  readonly dependencies?: readonly string[];
}

export interface ObservedCompositionMember {
  readonly path: string;
  readonly repoRecordId: string;
  readonly expectedOid: string;
  readonly expectedDigest?: string;
  readonly observedOid?: string;
  readonly observedDigest?: string;
  readonly freshness?: CompositionFreshness;
}

function normalizedRoot(root: string): string {
  const value = root.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return value === "." ? "" : value;
}

function scopeId(repoRecordId: string, root: string): string {
  return sha256Hex(canonicalize({ repoRecordId, root }));
}

export function buildScopeTree(
  repoRecordId: string,
  declarations: readonly ScopeDeclaration[],
): ScopeTree {
  const merged = new Map<
    string,
    { names: Set<string>; provenance: Set<ScopeProvenance>; dependencies: Set<string> }
  >();
  for (const declaration of declarations) {
    const root = normalizedRoot(declaration.root);
    if (!root) continue;
    const current = merged.get(root) ?? {
      names: new Set<string>(),
      provenance: new Set<ScopeProvenance>(),
      dependencies: new Set<string>(),
    };
    current.names.add(declaration.name);
    current.provenance.add(declaration.provenance);
    for (const dependency of declaration.dependencies ?? []) current.dependencies.add(dependency);
    merged.set(root, current);
  }
  const roots = [...merged.keys()].sort();
  const rootId = scopeId(repoRecordId, "");
  const nodes: ScopeTreeNode[] = [
    {
      id: rootId,
      name: repoRecordId,
      root: "",
      parentId: null,
      provenance: [],
      dependencies: [],
    },
  ];
  for (const root of roots) {
    const declaration = merged.get(root);
    if (!declaration) continue;
    const parentRoot = roots
      .filter((candidate) => candidate !== root && root.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
    nodes.push({
      id: scopeId(repoRecordId, root),
      name: [...declaration.names].sort().join(" / "),
      root,
      parentId: parentRoot ? scopeId(repoRecordId, parentRoot) : rootId,
      provenance: [...declaration.provenance].sort(),
      dependencies: [...declaration.dependencies].sort(),
    });
  }
  nodes.sort((a, b) => a.root.localeCompare(b.root) || a.id.localeCompare(b.id));
  return {
    repoRecordId,
    rootId,
    nodes,
    contentDigest: sha256Hex(canonicalize({ repoRecordId, rootId, nodes })),
  };
}

export function eagerScopeTree(tree: ScopeTree): ScopeTree {
  const direct = tree.nodes.filter(
    (node) => node.id === tree.rootId || node.parentId === tree.rootId,
  );
  return { ...tree, nodes: direct };
}

function compareStale(a: CompositionStaleMember, b: CompositionStaleMember): number {
  return a.path.localeCompare(b.path) || a.repoRecordId.localeCompare(b.repoRecordId);
}

export function evaluateCompositionFreshness(
  ownCurrent: boolean,
  observed: readonly ObservedCompositionMember[],
): CompositionFreshness {
  const stale: CompositionStaleMember[] = [];
  if (!ownCurrent) {
    stale.push({
      path: "",
      repoRecordId: "self",
      reason: "oid-mismatch",
      expectedOid: "current",
    });
  }
  for (const member of observed) {
    const common = {
      path: member.path,
      repoRecordId: member.repoRecordId,
      expectedOid: member.expectedOid,
      ...(member.expectedDigest ? { expectedDigest: member.expectedDigest } : {}),
      ...(member.observedOid ? { observedOid: member.observedOid } : {}),
      ...(member.observedDigest ? { observedDigest: member.observedDigest } : {}),
    };
    if (!member.observedOid) stale.push({ ...common, reason: "absent" });
    else if (member.observedOid !== member.expectedOid)
      stale.push({ ...common, reason: "oid-mismatch" });
    else if (member.expectedDigest && member.observedDigest !== member.expectedDigest) {
      stale.push({ ...common, reason: "digest-mismatch" });
    }
    for (const descendant of member.freshness?.staleMembers ?? []) {
      stale.push({ ...descendant, path: [member.path, descendant.path].filter(Boolean).join("/") });
    }
  }
  stale.sort(compareStale);
  return stale.length === 0
    ? { status: "current", staleMembers: [] }
    : { status: "stale", staleMembers: stale };
}

export function composeRepo(input: {
  readonly repoRecordId: string;
  readonly pinnedOid: string;
  readonly projectSnapshotId: string;
  readonly scopeTree: ScopeTree;
  readonly submodules: readonly RepoMapMember[];
  readonly observedMembers?: readonly ObservedCompositionMember[];
  readonly ownCurrent?: boolean;
}): RepoComposition {
  const submodules = [...input.submodules].sort((a, b) => a.path.localeCompare(b.path));
  const content = {
    repoRecordId: input.repoRecordId,
    pinnedOid: input.pinnedOid,
    projectSnapshotId: input.projectSnapshotId,
    scopeTreeDigest: input.scopeTree.contentDigest,
    submodules,
  };
  return {
    repoRecordId: input.repoRecordId,
    pinnedOid: input.pinnedOid,
    projectSnapshotId: input.projectSnapshotId,
    scopeTree: input.scopeTree,
    submodules,
    contentDigest: sha256Hex(canonicalize(content)),
    freshness: evaluateCompositionFreshness(
      input.ownCurrent ?? true,
      input.observedMembers ??
        submodules.map((member) =>
          member.status === "absent"
            ? {
                path: member.path,
                repoRecordId: member.repoRecordId,
                expectedOid: member.pinnedOid,
              }
            : {
                path: member.path,
                repoRecordId: member.reference.repoRecordId,
                expectedOid: member.reference.pinnedOid,
                expectedDigest: member.reference.contentDigest,
                observedOid: member.reference.pinnedOid,
                observedDigest: member.reference.contentDigest,
              },
        ),
    ),
  };
}

export function composeWorkspace(input: {
  readonly workspaceId: string;
  readonly members: readonly WorkspaceMember[];
  readonly edges: readonly CrossRepoEdge[];
  readonly observedMembers?: readonly ObservedCompositionMember[];
}): WorkspaceContext {
  const members = [...input.members].sort((a, b) => a.repoRecordId.localeCompare(b.repoRecordId));
  const edges = [...input.edges].sort((a, b) =>
    `${a.sourceRepoRecordId}\0${a.sourceScopeId}\0${a.kind}\0${a.destination.repoRecordId}`.localeCompare(
      `${b.sourceRepoRecordId}\0${b.sourceScopeId}\0${b.kind}\0${b.destination.repoRecordId}`,
    ),
  );
  return {
    workspaceId: input.workspaceId,
    members,
    edges,
    contentDigest: sha256Hex(canonicalize({ workspaceId: input.workspaceId, members, edges })),
    freshness: evaluateCompositionFreshness(true, input.observedMembers ?? []),
  };
}
