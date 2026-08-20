# Design: add-context-map-view

## Context

The Repo Map is fully shipped as data + tools: `ProjectSnapshotGenerator`/`ProjectSnapshotStore` persist the deterministic snapshot (`~/.rennet/projects/<repoKey>/map/…`), `KnowledgeStore` persists the model-derived knowledge set, `queryProjectMap`/`queryFileOverview` serve pure reads, and `contextAskBackend` (adapters) runs the model-backed ask engine keyed by `{repoKey, baseOid}` — not by review. `rennet map [--enrich] [--model]` mints both layers headless. The approved spike (`spikes/context-map-view`) fixed the layout: tree spine + neighborhood graph + knowledge panel + conversation rail. What's missing is protocol surface, a UI surface, and the human-confirm path R54 promises.

## Goals / Non-Goals

**Goals:**
- Browsable per-project Repo Map surface fed only by persisted data (fast, model-free reads).
- Project-scoped conversational ask over that data with honest failure states.
- Persisted human disposition (confirm/reject) of knowledge statements.

**Non-Goals:**
- Primer inspector: `buildPrimer` is review-coupled (canvas counts, run ledger); rendering `ProjectMap` directly is the display model. Revisit only if a project-scoped primer ever exists.
- Claim-text editing: disposition never edits claims (ids are content hashes; editing mints a new statement and blurs provenance).
- Triggering snapshot builds/enrichment from the surface: invalidation is automatic per contract; `rennet map` and daemon rehydration own minting.
- Live orchestrator session (canvasOps@2 MCP plumbing): `runContextAsk` is the whole engine needed here.

## Decisions

- **Render persisted data, don't rebuild**: `project.contextMap` reads `loadManifest` → `loadFresh` → `queryProjectMap` + `KnowledgeStore.loadLocal`. Alternative (rebuild on open) rejected: seconds-scale git walk on every open for data the store already holds.
- **Reuse `contextAskBackend` with a project resolve closure**: it already takes `resolve: () => {repoKey, baseOid}`; the only review-specific piece in the current wiring is the review's resolver. Alternative (new project ask engine) rejected: duplicate machinery.
- **`"rejected"` joins `KnowledgeStatus`** instead of deleting rejected statements. Deletion loses the record and lets the next enrichment re-mint the same claim as a fresh hypothesis; a recorded rejection is filterable and survives delta passes. Alternative (tombstone list beside the set) rejected: two sources of truth.
- **Surface = new `Surface { kind: "contextMap", projectId }`**, no recents entry (reachable from its project), no nav-history version bump (additive kind; rehydrator floors unknown entries already), no new command-palette `Screen` (navigation command lives under `projectDetail`).
- **UI conventions follow `project-detail.tsx`**: props-injected `RennetBridge`, local `useState`/`useMemo`, callback-prop navigation, co-located `*.dom.test.tsx` over a recording fake bridge.

## Risks / Trade-offs

- [Harness model safeguard misfire (seen: Fable 5 refused the enrichment prompt)] → ask results carry the harness failure verbatim; the rail renders it honestly. Model choice stays the harness default; `rennet map --model` exists for minting.
- [Large repos make the tree heavy (rennet: 1,611 files)] → roll-up counts with collapsed-by-default directories; symbols render only when a file is expanded. Virtualize only if real use shows jank.
- [Disposition races a concurrent enrichment save (daemon delta pass)] → last-write-wins on the whole-set atomic save; acceptable for a single-user local store. Revisit if a real loss is observed.
- [`"rejected"` widens a shipped type] → the only exhaustive consumers are display/serve paths; delta-pass carry logic treats statements opaquely by id. Typecheck flags any missed switch.

## Migration Plan

Additive throughout: new commands, new surface, new status value. No persisted-format version bumps (knowledge set schema unchanged in shape; `status` gains a value). Rollback = revert; stored sets containing `"rejected"` degrade to display-as-is under old code (unknown status renders as its literal), acceptable for a local personal store.

## Open Questions

(none blocking — enrichment-pass preservation of `rejected` on changed regions is asserted by test in this change)
