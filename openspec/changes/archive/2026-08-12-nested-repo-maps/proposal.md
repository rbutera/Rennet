# nested-repo-maps

**Issues: #142. Owner: Codex (Zone B). Review: single codex. Depends on: build-repo-map-lifecycle (the wave-1 snapshot + lifecycle base).**

## Why

`build-repo-map-lifecycle` deliberately stops at one git repository, so Rennet cannot yet describe how a monorepo's scopes, a parent's submodules, or several repositories in one workspace relate without flattening their maps together. Issue #142 / R54 adopts one uniform answer: keep each repository's `ProjectSnapshot` independent and compose maps deterministically by reference.

## What Changes

- Define **one Repo Map per git repository**. Within that repository, derive an internal scope tree from workspace tooling (`pnpm-workspace`, the Nx project graph, Cargo workspace members, and `go.work`), never from folder shape; build the repository root plus one scope level eagerly and serve deeper scope detail on demand through `context.map`.
- Define a uniform cross-map reference carrying the referenced `RepoRecord` identity, its pinned OID, and its content digest. Parent, submodule, and workspace compositions retain those references rather than copying child `ProjectSnapshot` shards or knowledge.
- Model every submodule as a separate `RepoRecord` with its own Repo Map, pinned to the gitlink OID recorded in the parent's tree. A gitlink advance becomes a first-class deterministic novelty-ledger event under #144. A missing submodule map is named in the `ContextManifest`; the parent map and review remain usable.
- Add the adopted `WorkspaceContext`: a thin, deterministic app-owned composition of member `RepoRecord` ids, current `projectSnapshotId` values, and cross-repo edges. Knowledge remains stored and retrieved per repository.
- Compose freshness as a conjunction over referenced members: the composition is `current` only when every referenced child is current at its pin, and every stale or absent member is named. This status is descriptive context metadata, never a review stop, consent step, or capability restriction.
- Use the same recursive reference and freshness rules for monorepos, submodules, multi-repo workspaces, and workspaces whose members contain submodules.

## Capabilities

### New Capabilities

- `nested-repo-maps`: deterministic scope-tree discovery, by-reference Repo Map composition, gitlink-pinned submodule maps, `WorkspaceContext`, recursive freshness, and `ContextManifest` disclosure.

### Modified Capabilities

None. This change composes onto `build-repo-map-lifecycle`; it does not redefine that change's `ProjectSnapshot`, base/overlay model, storage keying, or lifecycle requirements.

## Impact

- **`packages/types`:** additive node-free shapes for scope trees, cross-map references and edges, composed freshness, submodule membership, `WorkspaceContext`, and manifest disclosures.
- **`packages/core`:** pure deterministic scope-tree normalization, recursive composition, digesting, freshness evaluation, and gitlink novelty classification.
- **`packages/adapters`:** workspace-tool and gitlink discovery, per-repository `RepoRecord` resolution, composition loading from `~/.rennet/projects/<esc>/`, app-owned `WorkspaceContext` persistence, and `context.map` routing to scopes or referenced repositories.
- **No renderer, model, protocol, new dependency, or repository mutation.** Knowledge storage and generation stay per-repo. The existing `ContextManifest`, `context.map`, `ProjectSnapshot`, `projectSnapshotId`, Repo Map lifecycle, and base/overlay behavior remain the foundation.
