# Proposal: add-context-map-view

## Why

The Repo Map (deterministic ProjectSnapshot + model-derived knowledge layer + primer) is fully shipped as backend and tool surface, but has zero UI: nothing lets a person browse the map, and the R54 promise that a knowledge statement stays "a labelled hypothesis unless evidence or a human confirms it" has no human-confirm surface. The spike (`spikes/context-map-view`, approved 2026-08-20) proved the layout; this change builds the production surface.

## What Changes

- New `project.contextMap` protocol command: pure read of the persisted Repo Map — `{ map: ProjectMap, knowledge: KnowledgeSet | null }` via `queryProjectMap` + `KnowledgeStore.loadLocal`. No rebuild, no model turn.
- New per-project UI surface `Surface { kind: "contextMap", projectId }`: roll-up tree spine, neighborhood graph (selected scope + direct edges only), knowledge panel with statements rendered as labelled hypotheses, freshness badge; reached from Project Detail.
- New `project.contextAsk` protocol command: project-scoped orchestrator ask reusing the existing `contextAskBackend` (already keyed by `{repoKey, baseOid}`) with a persisted-tip resolve closure; conversational rail in the view with honest unanswered/failed states.
- New `project.knowledgeDisposition` protocol command: confirm/reject a knowledge statement, persisted via `KnowledgeStore.save`; `KnowledgeStatus` gains `"rejected"`.
- Docs: a Using-Rennet page for the Context Map view, in the same change.

Explicitly NOT changing: R54 doctrine (two-layer Repo Map stands), the primer (review-coupled; not rendered here in v1), claim-text editing (provenance-preserving disposition only).

## Capabilities

### New Capabilities
- `project-context-map`: reading and displaying a project's persisted Repo Map (structure + knowledge) as a navigable per-project surface.
- `project-context-ask`: project-scoped conversational retrieval over the persisted snapshot and knowledge set.
- `knowledge-disposition`: human confirm/reject of knowledge statements, persisted in the local knowledge set.

### Modified Capabilities

(none — no existing spec's requirements change)

## Impact

- `packages/types`: `KnowledgeStatus` union gains `"rejected"`.
- `packages/protocol`: three new command definitions + output schemas.
- `packages/server`: dispatch cases + create-server deps (reusing existing stores/readers/ports).
- `packages/app-ui`: `Surface` union, app routing/rehydration, breadcrumb label, Project Detail nav-out, new context-map screen component + dom test.
- `docs`: new Using page; settings-and-setup already covers `rennet map --enrich`.
- No new dependencies.
