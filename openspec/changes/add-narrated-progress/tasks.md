# Tasks — add-narrated-progress (#71)

> **Slice status (this PR):** the foundational, behaviour-preserving vertical has
> shipped — the shared organ + pure fold (extracted from the processing screen with
> its DOM guard intact), the additive protocol widening, anchoring, and the
> zero-model completeness proof. The deeper main-process/renderer wiring that
> threads progress through the review-capture pipeline and adds the in-memory
> replay buffer (tasks 3.2-3.4, 4, 5) is deliberately staged as a reviewed
> follow-up rather than force-landed onto the flagship review path — it follows the
> design's own "ship in consumer order, extraction first" migration plan. Unchecked
> boxes below are that follow-up.

## 1. Extract the shared organ (behaviour-preserving)

- [x] 1.1 Extract the event fold (`deriveView`) and trail rendering from `packages/ui/src/components/project-processing.tsx` into a shared `ProgressFeed` component + pure fold module; export from `packages/ui`
- [x] 1.2 Refactor `ProjectProcessing` to consume the shared organ; `project-processing.dom.test.tsx` passes UNMODIFIED (the behaviour-preservation guard)
- [x] 1.3 Red-proof the guard: reintroduce a one-line fold divergence in the consumer and confirm the existing DOM test reddens; revert
- [x] 1.4 Unit-test the extracted fold directly (stage-collapse/done-ledger, degraded no-events path, unknown-kind tolerance)

## 2. Protocol: widen the progress event union (additive)

- [x] 2.1 Add capture/review event kinds (capture milestone, floor completion, per-angle admission, terminal) to the progress event union in `packages/protocol/src/index.ts` — hand-written Zod, discriminated by `kind`, payloads carry counts/ids/titles only (no model prose)
- [x] 2.2 Add the typed optional artifact ref (project | review) to terminal/landed events for anchoring
- [x] 2.3 Typecheck the whole tree after widening; fix any exhaustive-switch fallout by tolerant default, not by narrowing the union

## 3. Stable ids + replay (leave and return)

- [x] 3.1 Key `project.process` progress on a deterministic per-run id (project id) instead of a renderer-minted UUID; renderer derives the same id on re-mount
- [ ] 3.2 Main keeps a bounded in-memory event log per live run; a mid-run subscriber receives the backlog as a replay prefix then live events; terminal event clears the buffer — **DEFERRED (follow-up)**
- [ ] 3.3 Projects list subscribes to live-run ids and shows the in-progress glyph on a project card until the terminal event arrives — **DEFERRED (follow-up)**
- [ ] 3.4 Returning to the processing slot mid-run re-attaches (replay + live); returning after completion shows the completed summary including per-repo failures — DOM tests for both, mounted through the real bridge seam (composition-root test, not props-only) — **DEFERRED (follow-up)**

## 4. The capture/review wait narrates

- [ ] 4.1 Emit deterministic progress events from the capture/review pipeline's real seams (capture complete, floor completion, per-angle admission) through the dispatch `emitProgress` context; dispatch owns the terminal event so stream and resolved value agree — **DEFERRED (follow-up; the union + transport are ready)**
- [ ] 4.2 Replace the mute busy-bar during capture/regenerate/review-generation with the shared `ProgressFeed` (spinner-over-feed); keep the graceful no-push-channel degraded mode — **DEFERRED (follow-up)**
- [ ] 4.3 Soft failures render honestly in the feed and the run continues (workspace one-repo-fails precedent) — **DEFERRED (follow-up; `review-error` kind is defined)**

## 5. Refresh narration lights up

- [ ] 5.1 Renderer subscribes to `PROACTIVE_REHYDRATION_COMMAND_ID` and surfaces background passes through the shared organ as ambient chrome (project-card glyph + compact line); never a modal takeover — **DEFERRED (follow-up)**
- [ ] 5.2 DOM test: a rehydration event stream produces the ambient indicator without replacing the current surface — **DEFERRED (follow-up)**

## 6. Anchors

- [x] 6.1 Fold surfaces the optional artifact ref as an anchor on landed lines; consumers navigate via existing flow handlers (open project detail, open review)
- [x] 6.2 A line without an artifact renders as plain text: not focusable-as-link, no dead navigation — test both directions

## 7. Zero-model completeness proof

- [x] 7.1 Test: run the narrated fold with the model utility port stubbed out; assert the feed is complete (lines, details, ledger, terminal state) and no model invocation occurred
- [x] 7.2 Red-proof it: make one feed line stop deriving from a real event and confirm the test reddens for THAT reason; revert

## 8. Wrap-up

- [x] 8.1 Full green pass for this slice: affected typecheck, test, and lint targets (lint explicitly — the uqjz7 class) across protocol, ui, and desktop
- [x] 8.2 Update the developer docs (reactive-streams reference) to name the shared narration organ and the one-vocabulary/zero-model/anchoring properties
