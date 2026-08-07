## Why

Rennet is, at its core, "a bunch of canvases the agent fills and the user interacts with" (Product and Vision §4.2; [[Rennet Canvas Paradigm]]). Issues #6/#7/#8/#9 shipped the RSP document substrate, the deterministic decomposition floor, angle generation, and the comprehension-ordering pass — the analysis that a canvas displays. What is missing is the canvas itself: a named, addressable, layered projection over the event store that turns admitted RSP documents into a surface the user disposes on and the orchestrator marks up, without ever letting an agent touch the user's judgment.

The canvas is the object the whole interaction contract stands on. Its four layers encode the actor partition structurally: L0 substrate (deterministic ingest owns it), L1 analysis (a pure projector places validator-admitted documents — fleet agents never touch a canvas), L2 dispositions (user-sovereign — no agent-reachable command writes it), L3 annotations (the orchestrator's ephemeral, session-scoped marks). "The human still disposes" becomes a property of the wiring, not an instruction (Contracts §2.3, §3 frozen doctrine).

## What Changes

- Add the canvas data model to `packages/types`: `Canvas` keyed `(reviewId, patchsetId, angle)`, the five canvas angles (spec/sequence/decisions/claims/noise), the four layers (`SubstrateLayer`, `AnalysisLayer` with cohorts, `DispositionLayer`, `AnnotationLayer` with proposals), the blast-radius overlay, and the change-feed notification shape. Canvas elements reference admitted docs by `docId` + anchor and mint no identity of their own.
- Add the canvas state model to `packages/core` (`canvas.ts`): the deterministic `canvasId`; a **pure L1 projector** that places admitted RSP documents onto canvas elements (decisions grouped into cohorts and ordered by decomposition DAG position, never capped; sequence in the admitted reading order; spec/claims/noise/overlay placed deterministically); the canvas-op event family (`CanvasAnnotated`, `AnnotationPinned`, `AnnotationCleared`, `ProposalRaised`, `ProposalAdjudicated`, `SessionEnded`) and its fold with session-scoped L3 lifecycle; `buildCanvas` assembling the full four-layer projection from admitted docs + decomposition + the review's dispositions + the canvas-op events; `carrySuccessorDispositions` (exact-lineage carry — a byte-identical file's approval carries, a changed file's does not); and the actor-partitioned command vocabularies with structural enforcement that no orchestrator op can write L2.
- Add the canvas-scoped post-commit change feed to `packages/core` (`canvas-change-feed.ts`): a dependency-free typed emitter keyed `(reviewId, canvasId, elementKey)` with a covering seq range, per-key conflation (a conflated notification names the seq range it covers), bounded buffers, private rows never published, and gap-driven re-query (a consumer that misses notifications re-queries the projection — truth stays the store). This is the canvas half of R35's one change feed; the emission-point plumbing is #31's.
- Add the user canvas IPC commands to `packages/protocol` (`canvas.disposition`, `canvas.adjudicateProposal`, `canvas.setCohortExpansion`, `canvas.select`, `canvas.pinAnnotation`, `canvas.clearAnnotation`) so the renderer reaches the engine through the existing command map (R20), and assert structurally that no agent/orchestrator disposition-write command exists.

## Capabilities

### New Capabilities

- `canvas-state-model`: the `Canvas` four-layer model, the deterministic L1 projector, the canvas-op event fold with session-scoped L3, `buildCanvas`, the exact-lineage successor carry, the actor-partitioned command vocabularies with structural L2 sovereignty, and the canvas-scoped post-commit change feed.

## Impact

- Adds `packages/core/src/canvas.ts` and `packages/core/src/canvas-change-feed.ts` (re-exported from `core/index.ts`, colocated-tested). Extends `packages/types/src/index.ts` and `packages/protocol/src/index.ts`. No new package, no new external dependency, no dependency-arrow change: the architecture and licenses gates are untouched.
- L2 is user-sovereign by construction: the orchestrator op vocabulary contains no disposition writer, and orchestrator dispatch structurally cannot emit a disposition event. A disposition reaches L2 only through the user command (a direct `canvas.disposition` or accepting a proposal — a user act).
- Deferred to follow-up beads/issues: the in-process canvas MCP server that serves the orchestrator ops (`canvasOps@2`, Orchestrator Context Access); the change-feed emission point in the engine process (#31); the calibrated fuzzy successor matcher that upgrades the exact-only carry (Spike 1); rich spec/claims/noise element bodies (#26); the rendered canvas UI (#11).
