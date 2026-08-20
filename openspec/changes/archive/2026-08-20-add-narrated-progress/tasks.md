# Tasks — add-narrated-progress (#71)

> **Implementation status corrected after PR #321 review:** the proposal, design,
> and specification still describe the whole issue #71 capability. Commit
> `df13f0c`'s task scope was not superseded by the first implementation slice.
> This branch currently ships the shared processing feed, live-run dedup/replay,
> and processing-artifact navigation. Every
> unchecked item below remains required to complete issue #71; “follow-up” is not
> a scope removal.

## 1. Extract the shared organ (behaviour-preserving)

- [x] 1.1 Extract the event fold (`deriveView`) and trail rendering from `packages/app-ui/src/components/project-processing.tsx` into a shared `ProgressFeed` component + pure fold module; consumers import the internal modules directly until another package needs them
- [x] 1.2 Refactor `ProjectProcessing` to consume the shared organ; the original `project-processing.dom.test.tsx` behaviour-preservation guard passed, and later regressions extend it
- [x] 1.3 Red-proof the guard: reintroduce a one-line fold divergence in the consumer and confirm the existing DOM test reddens; revert
- [x] 1.4 Unit-test the extracted fold directly (stage-collapse/done-ledger, degraded no-events path, unknown-kind tolerance)

## 2. Protocol: widen the progress event union (additive)

- [ ] 2.1 Add capture/review event kinds (capture milestone, floor completion, per-angle admission, terminal) to the progress event union in `packages/protocol/src/index.ts` with their production emitters — hand-written Zod, discriminated by `kind`, payloads carry counts/ids/titles only (no model prose). **Speculative zero-emitter variants were removed from the first slice.**
- [ ] 2.2 Add typed optional artifact refs to terminal/landed events for anchoring. **Partial:** the processing path carries project refs; review refs await the review emitter and renderer.
- [ ] 2.3 Typecheck the whole tree after widening; fix any exhaustive-switch fallout by tolerant default, not by narrowing the union

## 3. Stable ids + replay (leave and return)

- [ ] 3.1 Key `project.process` progress on a deterministic per-run id (project id + run epoch) instead of a renderer-minted UUID; renderer derives the same id on re-mount. **Partial:** a session-scoped project-to-command-UUID registry preserves remount identity; a distinct run epoch is not live.
- [x] 3.2 Main keeps a bounded in-memory event log per live run; a mid-run subscriber receives the backlog as a replay prefix then live events; terminal event clears the buffer
- [ ] 3.3 Projects list subscribes to live-run ids and shows the in-progress glyph on a project card until the terminal event arrives
- [ ] 3.4 Returning to the processing slot mid-run re-attaches (replay + live); returning after completion shows the completed summary including per-repo failures — DOM tests for both, mounted through the real bridge seam (composition-root test, not props-only). **Partial:** dispatcher-level remount replay is red-proofed; project-card state and the completed-summary composition test are not implemented.

## 4. The capture/review wait narrates

- [ ] 4.1 Emit deterministic progress events from the capture/review pipeline's real seams (capture complete, floor completion, per-angle admission) through the dispatch `emitProgress` context; dispatch owns the terminal event so stream and resolved value agree. Add the protocol variants with these production emitters.
- [ ] 4.2 Replace the mute busy-bar during capture/regenerate/review-generation with the shared `ProgressFeed` (spinner-over-feed); keep the graceful no-push-channel degraded mode
- [ ] 4.3 Soft failures render honestly in the feed and the run continues (workspace one-repo-fails precedent)

## 5. Refresh narration lights up

- [ ] 5.1 Renderer subscribes to `PROACTIVE_REHYDRATION_COMMAND_ID` and surfaces background passes through the shared organ as ambient chrome (project-card glyph + compact line); never a modal takeover
- [ ] 5.2 DOM test: a rehydration event stream produces the ambient indicator without replacing the current surface

## 6. Anchors

- [ ] 6.1 Fold surfaces the optional artifact ref as an anchor on landed lines; consumers navigate via existing flow handlers (open project detail, open review). **Partial:** project processing emits and opens its project artifact through the real consumer; review emission/navigation awaits task 4.
- [x] 6.2 A line without an artifact renders as plain text: not focusable-as-link, no dead navigation — test both directions

## 7. Zero-model completeness proof

- [ ] 7.1 Test: run the narrated slots with the model utility port stubbed out; assert the feed is complete (lines, details, ledger, terminal state) and no model invocation occurred
- [ ] 7.2 Red-proof it: make one feed line depend on model output in a scratch mutation and confirm the test reddens for THAT reason; revert

## 8. Wrap-up

- [x] 8.1 Full green pass for this slice: affected typecheck, test, and lint targets (lint explicitly — the uqjz7 class) across protocol, ui, and desktop
- [x] 8.2 Update the developer docs (reactive-streams reference) to name the shared narration organ and the one-vocabulary/zero-model/anchoring properties
