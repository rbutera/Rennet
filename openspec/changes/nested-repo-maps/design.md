# Design — nested Repo Maps (#142)

## Context

`build-repo-map-lifecycle` is the base and remains authoritative for the per-repository `ProjectSnapshot`, `RepoRecord`, `~/.rennet/projects/<esc>/` layout, `context.map`, `ContextManifest`, `projectSnapshotId`, local-first lookup, and default-base plus overlay composition. That change explicitly defers nested maps and `WorkspaceContext` here.

The missing layer is composition. A `ProjectSnapshot` already describes one repository, including a flat workspace-scope inventory, but there is no deterministic object that says which tool-declared scopes nest inside it, which other repository a gitlink names, or which repositories participate in one application workspace. R54 settles the architecture: repository maps remain independent, all cross-map composition is by reference, and freshness is conjunctive and names stale members.

Rule Zero constrains the read behavior. Composition status must tell the truth about missing or stale members, but it must not stop a review, deny an agent a capability, or add an approval step. The current repository's valid `ProjectSnapshot` remains usable even when one referenced child cannot be supplied.

## Goals / Non-Goals

**Goals:**

- Represent monorepo scopes, submodules, and multi-repo workspaces with one deterministic recursive composition model.
- Preserve one `ProjectSnapshot` and one knowledge store per git repository.
- Pin submodule context to the parent's gitlink OID and identify gitlink advances as deterministic novelty.
- Make `context.map` cheap at the repository root, useful at one scope level, and able to materialize deeper tool-declared scopes on demand.
- Persist thin per-repository composition records beside the existing lifecycle store and `WorkspaceContext` in app-owned storage.
- Return exact, named composition freshness without turning it into a product gate.

**Non-Goals:**

- No renderer, protocol surface, model call, workspace-level knowledge, folder-based scope inference, repository cloning policy, or change to publication behavior.
- No replacement for `ProjectSnapshot`, no per-package snapshot, and no inlining of child shards or child knowledge.
- No change to `build-repo-map-lifecycle` storage precedence, base/overlay semantics, promotion, or proactive refresh.
- No consent, approval, read-only, sandbox, or capability-denial mechanism.

## Decisions

### 1. A repository composition record references the existing snapshot

Add an additive, node-free composition model in `packages/types`; do not change the `ProjectSnapshot` schema. Conceptually:

```ts
interface RepoMapReference {
  repoRecordId: string
  pinnedOid: string
  projectSnapshotId: string
  contentDigest: string
}

interface RepoComposition {
  repoRecordId: string
  pinnedOid: string
  projectSnapshotId: string
  scopeTreeDigest: string
  submodules: readonly RepoMapMember[]
  contentDigest: string
}

type RepoMapMember =
  | { status: "resolved"; path: string; reference: RepoMapReference }
  | { status: "absent"; path: string; repoRecordId: string; pinnedOid: string }
```

`repoRecordId` reuses the lifecycle change's `RepoRecord` identity (`repoKey` under its path-keyed storage decision); this change adds no forge matching or second identity system. `contentDigest` is the canonical digest of the referenced repository's model-free composition record: its `projectSnapshotId`, scope-tree digest, and sorted child references. It never covers knowledge. A resolved cross-map edge therefore always carries the adopted tuple `(identity, pinned OID, content digest)`, plus the exact `projectSnapshotId` needed by existing context reads.

An absent member is discovery metadata, not a resolved cross-map edge: it carries the expected identity and pin but cannot claim a child content digest that does not exist. The `ContextManifest` reports it as absent.

Alternative rejected: embed child snapshot shards in the parent. That duplicates content, breaks per-repo ownership, and makes a child update rewrite every ancestor rather than update a reference digest.

### 2. The scope tree contains only tool-declared scopes

Adapters discover scope declarations from `pnpm-workspace.yaml`, the Nx project graph, Cargo workspace members, and `go.work`. Core normalizes those declarations into a synthetic repository-root node plus `ScopeTreeNode`s keyed by `(repoRecordId, normalized declared root)`. If more than one tool declares the same root, their provenance is merged; dependency edges are unioned, de-duplicated, and sorted. A node's parent is the nearest enclosing **tool-declared** scope root. Arbitrary directories never become nodes, and a repository with no supported workspace declaration has only the root node.

The complete normalized tree is cheap metadata. The eager `context.map` projection contains the repository root and its direct scope children. A request for a deeper declared scope uses the existing path-scoped `context.map` projection over the same `ProjectSnapshot`; it does not build or store a package-level map. This satisfies eager root plus one level while retaining one map per git repository.

Alternative rejected: use directory depth or package-looking filenames as scope boundaries. That invents scopes the repository's own tooling does not recognize and diverges from its actual project graph.

### 3. A submodule is a separate RepoRecord pinned from the parent tree

Adapters enumerate tree entries with git mode `160000` at the parent's `pinnedOid`; `.gitmodules` supplies submodule naming and location metadata, but never the content pin. The tree entry's OID is authoritative even when the checked-out submodule is absent, detached elsewhere, or on a newer commit.

The child uses the lifecycle base/overlay model rather than a second snapshot mechanism. If the gitlink equals the child's default-map OID, the child reference names that base `projectSnapshotId`; otherwise the gitlink is an effective non-default base and the existing overlay machinery yields the composite `projectSnapshotId`. The child composition is then built recursively at that exact pin.

When the child source/map is not available through the normal lifecycle resolver, the parent records an absent member and proceeds. Rennet does not substitute the child repository's current checkout, default branch, or a stale map.

### 4. Gitlink movement is a first-class novelty item

The deterministic novelty classifier compares `160000` entries by path and OID. The same submodule path changing from one gitlink OID to another emits `gitlink-advance` with the path, child `RepoRecord` identity, old OID, and new OID. The event participates in #144's existing ledger and baseline pin; this change adds no model judgment.

Additions and removals remain ordinary structural additions/removals with submodule identity attached. A checkout's current submodule `HEAD` is never novelty evidence because it is not part of the parent's immutable tree.

### 5. WorkspaceContext is a thin app-owned composition

`WorkspaceContext` contains a stable workspace id, sorted member records (`RepoRecord` id, member pin, current `projectSnapshotId`, and composition digest), sorted cross-repo edges, a canonical content digest, and composed freshness. Cross-repo edges identify a source scope and carry a full `RepoMapReference` for the destination. Membership is supplied by the application workspace; adapters derive dependency edges only from workspace-tool graphs, dependency manifests that resolve to declared members, or explicit shared-contract relationships. Rennet does not scan neighboring folders to invent members.

Per-repository composition metadata lives alongside the lifecycle entry at `~/.rennet/projects/<esc>/composition.json`. Workspace compositions live at `~/.rennet/workspaces/<workspace-id>/context.json`. Both are deterministic derived data in app-owned storage. Reads still resolve every member map through the lifecycle change's local-first/committed-fallback behavior; this change does not create another map store or promotion policy.

Knowledge ids or knowledge bodies are not fields of `WorkspaceContext`. A consumer that wants knowledge follows the member reference and asks that repository's existing `context.knowledge` path, preserving repo-scoped evidence.

### 6. Freshness is recursive metadata, not an execution barrier

Core evaluates a repository composition against its own effective `projectSnapshotId` and every discovered child member. A composition is `current` exactly when its own snapshot matches its pin and every descendant reference resolves at the recorded OID and digest. Otherwise it is `stale`, with a stable, sorted `staleMembers` list carrying the reference path, `RepoRecord` identity, expected pin/digest, observed values when available, and reason (`absent`, `oid-mismatch`, or `digest-mismatch`). `WorkspaceContext` applies the same conjunction to all members.

Traversal keys nodes by `(repoRecordId, pinnedOid, contentDigest)` so repeated references share one result. Workspace dependency cycles do not recurse through content: recursion follows membership/submodule references, while dependency edges remain data.

This verdict belongs beside the parent result in the `ContextManifest`. The parent `ProjectSnapshot` and its own `context.map` answer are still returned; current child answers may also be returned; stale or absent child contents are not represented as current and are named instead. Reviews, test execution, writing, and pushing do not wait for or depend on composed freshness.

### 7. One recursion serves every topology

The composer accepts a repository node plus zero or more child references and produces the same `RepoComposition` regardless of why the child exists. A monorepo contributes scope nodes within the current repository. A submodule contributes a child repository reference. A multi-repo workspace contributes member repository references and cross-repo edges. A workspace member that is a monorepo with submodules therefore needs no special case: scope projections stay inside its `ProjectSnapshot`, and submodule references recurse normally.

All arrays are sorted before canonical hashing: scope nodes by normalized root then id, submodules by parent-relative path, workspace members by `repoRecordId`, and edges by source/target/kind. Input order cannot change `contentDigest` or `workspaceContextId`.

## Risks / Trade-offs

- **Tool declarations can overlap or disagree.** → Normalize only declared roots, merge provenance at identical roots, preserve distinct declared roots, and use deterministic ordering; do not arbitrate by scanning folders.
- **A workspace composition can be stale because one optional submodule map is absent.** → Name that member while continuing to serve the parent and every available current member. The composition status is honest metadata, not a blocker.
- **A gitlink may point to an object unavailable locally.** → Record the exact expected OID as absent; never replace it with the child's default branch. Normal lifecycle acquisition can fill the reference later.
- **Large monorepos may have many deep scopes.** → Keep one repository snapshot and eagerly project only root plus direct children; deeper `context.map` reads filter the existing snapshot on demand.
- **Path-keyed RepoRecord identity is checkout-local.** → Reuse the lifecycle change's chosen `repoKey` and relocation/alias behavior rather than reopening #141 inside #142.

## Migration Plan

This is additive. Existing per-repository snapshots, overlays, knowledge, and `projectSnapshotId` values remain valid. On first composition read, adapters derive `composition.json` from the current snapshot, workspace-tool inputs, and gitlink tree entries; no source-repository file changes. Existing single-repo callers receive the same repository map plus root-only composition metadata. Removing the derived composition files reverts to the existing single-repository behavior without migrating snapshot shards.

## Open Questions

None. R54 and issue #142 settle the unit, reference tuple, gitlink pin, eager depth, workspace shape, freshness rule, and per-repository knowledge boundary.
