# Tasks — nested-repo-maps (#142)

Implementation verification: `pnpm check` (green = exit 0 and `Successfully ran target`). Red-proof each behavioral slice before implementing it; assert the public composition contract, not private helper structure.

## 1. Add the composition data model (`packages/types`)

- [x] 1.1 Add node-free `ScopeTreeNode` / scope-provenance shapes for a synthetic repository root and tool-declared descendants.
- [x] 1.2 Add `RepoMapReference`, resolved/absent `RepoMapMember`, `RepoComposition`, and composed-freshness shapes carrying identity, pinned OID, `projectSnapshotId`, content digest, and named stale-member details.
- [x] 1.3 Add `WorkspaceContext`, workspace-member, and cross-repo-edge shapes with canonical identity/digest fields; keep knowledge out of every workspace shape.
- [x] 1.4 Add the `ContextManifest` nested-map disclosure shape and the Stage-1 `gitlink-advance` novelty item shape without changing the existing `ProjectSnapshot` contract.

## 2. Build deterministic scope and composition logic (`packages/core`)

- [x] 2.1 Normalize pnpm, Nx, Cargo, and `go.work` declarations into one scope tree: merge provenance at identical declared roots, attach each node to its nearest enclosing declared root, de-duplicate/sort edges, and never infer a scope from a directory alone.
- [x] 2.2 Project the repository root plus direct scope children eagerly and route a deeper declared scope through the existing path-scoped `context.map` query over the same `ProjectSnapshot`.
- [x] 2.3 Canonically compose and hash `RepoComposition` records by reference, sorting scope nodes, submodules, and edges before digesting and excluding child shards and knowledge.
- [x] 2.4 Implement recursive conjunctive freshness with deterministic named `absent`, `oid-mismatch`, and `digest-mismatch` members while keeping the current parent map in the result.
- [x] 2.5 Compose `WorkspaceContext` deterministically from declared members and cross-repo edges, reusing the repository recursion for members that contain submodules.
- [x] 2.6 Classify a same-path mode-`160000` OID change as a model-free `gitlink-advance` novelty item carrying child identity and old/new pins.

## 3. Discover and persist composition inputs (`packages/adapters`)

- [x] 3.1 Add pinned-tree workspace discovery for `pnpm-workspace.yaml`, the Nx project graph, Cargo workspace members, and `go.work`, returning normalized declarations to core without scanning for package-looking folders.
- [x] 3.2 Discover submodules from mode-`160000` entries at the parent `pinnedOid`; use `.gitmodules` only for identity/location metadata and preserve the tree entry OID as the content pin.
- [x] 3.3 Resolve each submodule as its own `RepoRecord` through `~/.rennet/projects/<esc>/`; when its gitlink is not its default-map OID, reuse the existing base+overlay machinery to obtain the effective `projectSnapshotId`.
- [x] 3.4 Persist deterministic per-repository composition at `~/.rennet/projects/<esc>/composition.json` and `WorkspaceContext` at `~/.rennet/workspaces/<workspace-id>/context.json`, using the lifecycle change's local-first map resolver for every referenced member.
- [x] 3.5 Route root/direct/deep scope and referenced-repository reads through `context.map`, and add absent/stale member disclosures to the `ContextManifest` without conditioning review, test, write, or push paths on composition freshness.

## 4. Prove the contracts

- [x] 4.1 Red-then-green: pnpm, Nx, Cargo, and `go.work` fixtures produce deterministic tool-declared scope trees; a package-shaped decoy directory never becomes a scope; deep reads use the same repository `ProjectSnapshot`.
- [x] 4.2 Red-then-green: nested compositions contain only identity/OID/`projectSnapshotId`/digest references, never child shards or knowledge, and shuffled discovery order produces byte-identical digests.
- [x] 4.3 Red-then-green with real git repositories: a child checkout/default branch at `B` is still referenced at parent gitlink `A`, and a non-default gitlink resolves through the existing base+overlay path.
- [x] 4.4 Red-then-green: changing a mode-`160000` entry from `A` to `B` emits exactly one `gitlink-advance` item pinned to the ledger's baseline `projectSnapshotId`.
- [x] 4.5 Red-then-green: an absent or stale submodule makes composed freshness stale and is named in the `ContextManifest`, while the parent `context.map` result and all acting capabilities remain available with no consent or retry step.
- [x] 4.6 Red-then-green: a multi-repo workspace whose member is a monorepo with a submodule composes through the uniform recursion, names a stale grandchild, preserves current siblings, and contains no workspace-level knowledge.
- [x] 4.7 Run the full repository verification once, sequentially, and reconcile the result with the red-proof tests; no renderer or protocol project changes are permitted for this change.
