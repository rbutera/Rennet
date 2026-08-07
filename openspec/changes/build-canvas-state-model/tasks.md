## 1. Canvas data model (types)

- [x] 1.1 Add `CanvasAngle` (spec/sequence/decisions/claims/noise) + `CANVAS_ANGLES`
- [x] 1.2 Add L0 `SubstrateLayer`, L1 `AnalysisElement`/`AnalysisCohort`/`AnalysisLayer`, L2 `DispositionLayer`, L3 `Annotation`/`Proposal`/`AnnotationLayer`, `BlastRadiusPaint`, and the `Canvas` aggregate
- [x] 1.3 Add `DecisionRecordElement`/`DecisionRecordBody` (the minimal canvas-facing decision shape; #26's schema is an additive superset)
- [x] 1.4 Add `CanvasChangeNotification` (`{reviewId, canvasId, elementKey, seqRange:{from,to}}`)

## 2. Canvas state model (core)

- [x] 2.1 `canvasId(reviewId, patchsetId, angle)` — deterministic hash
- [x] 2.2 `projectAnalysis(angle, admittedDocs, decomposition)` — pure L1 projector: decisions→cohorts ordered by DAG position (never capped); sequence→admitted reading order; spec/claims/noise→doc-level elements; `elementKey = hash(docId, anchor)` (no minted identity)
- [x] 2.3 `projectBlastRadius(admittedDocs)` — the amber overlay from blast-radius-angle proposal chunks (never a writable layer)
- [x] 2.4 Canvas-op events + `foldCanvas` with session-scoped L3 lifecycle (SessionEnded drops unpinned, keeps pinned)
- [x] 2.5 `buildCanvas(input)` — assemble the four layers; L2 = the review's dispositions covered by this canvas's substrate; `canvasDigest` for byte-identical replay
- [x] 2.6 `carrySuccessorDispositions(previous, nextPatchset)` — exact-lineage carry (byte-identical file carries; changed file does not)
- [x] 2.7 `USER_CANVAS_COMMANDS` / `ORCHESTRATOR_CANVAS_OPS` vocabularies + `dispatchOrchestratorCanvasOp` whose effect type structurally excludes any L2 write

## 3. Canvas change feed (core)

- [x] 3.1 `CanvasChangeFeed`: subscribe/publish/flush, per-key conflation carrying the covering seq range, bounded buffers, private rows never published, notification payload shape locked

## 4. User IPC commands (protocol)

- [x] 4.1 Add the six user canvas commands to `commandDefinitions`
- [x] 4.2 Structural test: no agent/orchestrator disposition-write command exists in the registry

## 5. Tests + gates (every acceptance criterion, red→green)

- [x] 5.1 Canvas rebuilds byte-identically from event replay
- [x] 5.2 Same admitted docs projected twice → identical canvas (placement determinism); decisions never capped (500-element cohort survives)
- [x] 5.3 No agent-reachable path can write L2 (orchestrator vocabulary + dispatch effects, structural)
- [x] 5.4 Session end clears unpinned L3; pinned survives
- [x] 5.5 New patchset → successor canvas with exact-only carry; a changed file's approval does NOT carry, an unchanged file's does
- [x] 5.6 Change feed: conflation carries its range; missed-notification recovery via gap-driven re-query; private rows never published; payload carries no raw event
- [x] 5.7 `pnpm check` green across all projects
