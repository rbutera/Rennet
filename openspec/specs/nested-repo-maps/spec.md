# nested-repo-maps Specification

## Purpose
TBD - created by archiving change nested-repo-maps. Update Purpose after archive.
## Requirements
### Requirement: The unit of a Repo Map is one git repository

Rennet SHALL keep one `ProjectSnapshot` and one Repo Map per git repository. Inside that repository it SHALL derive a scope tree only from supported workspace-tool declarations: `pnpm-workspace`, the Nx project graph, Cargo workspace members, and `go.work`. The tree SHALL contain a synthetic repository root and tool-declared scope nodes; arbitrary folders SHALL NOT become scopes. The root and its direct child scopes SHALL be projected eagerly, while a deeper declared scope SHALL be served on demand through `context.map` over the same repository `ProjectSnapshot`.

#### Scenario: Tool declarations define scopes and folder shape does not

- **WHEN** a repository has tool-declared scopes plus an unrelated directory that merely resembles a package
- **THEN** the declared scopes appear in the scope tree and the unrelated directory does not
- **AND** exactly one repository `ProjectSnapshot` backs every scope

#### Scenario: A deep scope is served on demand

- **WHEN** a tool-declared scope lies below the root's direct scope level
- **THEN** the eager root map names its declared ancestry without materializing a separate map
- **AND** `context.map` for that scope returns a deterministic projection from the same `ProjectSnapshot`

### Requirement: Cross-map composition is by reference and never by inlining

Every resolved cross-map edge SHALL carry the referenced `RepoRecord` identity, pinned OID, `projectSnapshotId`, and deterministic content digest. A parent composition SHALL retain those references and SHALL NOT copy child `ProjectSnapshot` shards or child knowledge. Canonical sorting and hashing SHALL make the same graph produce the same composition digest regardless of discovery order.

#### Scenario: A nested child remains a reference

- **WHEN** a parent repository composes a child repository whose map contains structural shards and knowledge
- **THEN** the parent stores only the child's identity, pinned OID, `projectSnapshotId`, and content digest
- **AND** no child shard bytes or knowledge statements are present in the parent composition

#### Scenario: Discovery order does not change identity

- **WHEN** the same members and edges are supplied in different orders
- **THEN** their canonical composition digests are equal

### Requirement: A submodule is a separate RepoRecord pinned at the parent gitlink OID

For every git tree entry with mode `160000`, Rennet SHALL represent the submodule as a separate `RepoRecord` and SHALL use the entry's OID from the parent's pinned tree as the child map pin. It SHALL NOT substitute the submodule checkout's `HEAD` or the child repository's default-branch OID. When the gitlink differs from the child's default-map OID, the child SHALL reuse `build-repo-map-lifecycle`'s base+overlay composition to produce the effective `projectSnapshotId` at the gitlink.

#### Scenario: The checked-out child is ahead of the gitlink

- **WHEN** the parent tree records submodule OID `A` while the checked-out child and its default branch point at `B`
- **THEN** the child Repo Map reference is pinned to `A`
- **AND** no context from `B` is represented as the parent's submodule context

#### Scenario: A non-default gitlink reuses base plus overlay

- **WHEN** a gitlink OID differs from the child's default-map OID and the required objects are available
- **THEN** the child reference names the composite `projectSnapshotId` produced by the existing base+overlay model at that gitlink

### Requirement: A gitlink advance is a first-class deterministic novelty event

The Stage-1 novelty ledger SHALL classify a mode-`160000` entry whose OID changes at the same path as `gitlink-advance`. The item SHALL carry the submodule path, child `RepoRecord` identity, old gitlink OID, new gitlink OID, and the ledger's existing baseline `projectSnapshotId` pin. The classification SHALL be model-free.

#### Scenario: Parent advances one submodule pin

- **WHEN** a parent changes a submodule entry at `vendor/tool` from OID `A` to OID `B`
- **THEN** the deterministic novelty ledger contains one `gitlink-advance` item naming `vendor/tool`, `A`, and `B`
- **AND** the child's current default-branch OID does not affect that item

### Requirement: An absent submodule map is disclosed and the parent remains usable

When a discovered submodule cannot resolve a map at its gitlink OID, Rennet SHALL add an absent member disclosure to the `ContextManifest` naming its path, `RepoRecord` identity, and pinned OID. The composed freshness SHALL name that member as non-current, while the parent's valid `ProjectSnapshot`, its `context.map` answer, the review, and agent acting capabilities SHALL remain usable without an approval or retry step.

#### Scenario: Parent context survives a missing child map

- **WHEN** a parent's `ProjectSnapshot` is current and one submodule map is absent at its gitlink OID
- **THEN** `context.map` returns the parent's map
- **AND** the `ContextManifest` names the absent child and pin
- **AND** no review, test, write, or push capability waits on or is denied by that absence

### Requirement: WorkspaceContext is a thin deterministic app-owned composition

`WorkspaceContext` SHALL live in app-owned storage and SHALL contain sorted member `RepoRecord` ids, each member's pinned OID, current `projectSnapshotId`, and composition digest, plus sorted cross-repo edges and a canonical workspace digest. Each cross-repo edge SHALL reference its destination by the same identity/OID/digest tuple used for submodules. Membership SHALL come from the application workspace, and cross-repo edges SHALL come only from workspace-tool graphs, dependency manifests resolving to declared members, or explicit shared-contract relationships. Knowledge SHALL remain per repository and SHALL NOT be copied into `WorkspaceContext`.

#### Scenario: The same workspace composes byte-identically

- **WHEN** the same member records and cross-repo edges are composed twice in different input orders
- **THEN** the two `WorkspaceContext` values have the same canonical digest and ordered contents

#### Scenario: Workspace knowledge remains per repository

- **WHEN** two workspace members each have knowledge statements
- **THEN** `WorkspaceContext` references their repository maps without containing either member's knowledge statements

### Requirement: Composition freshness is the conjunction of recursively referenced members

A repository composition or `WorkspaceContext` SHALL be `current` only when its own effective snapshot matches its pin and every recursively referenced member resolves at its pinned OID and content digest. Otherwise its composition freshness SHALL be `stale` and SHALL carry a deterministic, sorted list naming every absent, OID-mismatched, or digest-mismatched member with expected and observed values where available. This composed verdict SHALL be descriptive metadata and SHALL NOT prevent the use of an otherwise current parent map.

#### Scenario: A stale grandchild names the full member

- **WHEN** a workspace member contains a submodule whose available map does not match the gitlink OID
- **THEN** the workspace composition is `stale`
- **AND** its stale-member list names the member, submodule path, expected gitlink OID, and observed OID
- **AND** current parent and sibling maps remain available

#### Scenario: Every member is current at its pin

- **WHEN** every workspace member and recursively referenced submodule resolves at its pinned OID and content digest
- **THEN** the repository compositions and the enclosing `WorkspaceContext` are `current`

### Requirement: One recursion composes monorepos, submodules, and workspaces-with-submodules

The composer SHALL use the same repository-node, scope-tree, cross-map-reference, digest, and freshness rules for a standalone monorepo, a repository with submodules, a multi-repo workspace, and a workspace whose members are monorepos containing submodules. Dependency edges SHALL remain graph data; recursive traversal SHALL follow repository membership and submodule references.

#### Scenario: A workspace member is a monorepo with a submodule

- **WHEN** a `WorkspaceContext` member has tool-declared scopes and one scope contains a gitlink
- **THEN** its scopes remain projections inside the member's one `ProjectSnapshot`
- **AND** its submodule is a separate by-reference child pinned at the gitlink OID
- **AND** the enclosing workspace uses the same member-reference and freshness rules without inlining either map

