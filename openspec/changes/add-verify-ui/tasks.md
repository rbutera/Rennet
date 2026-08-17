# Tasks — add-verify-ui (#183)

Red-first throughout: every guard lands with a demonstrated failure (write the
assertion against the unwired/absent behaviour, watch it fail, wire, watch it
pass). A control that cannot fail is the bug class delivery-order names.

## 1. Types + protocol (additive field, faithful transport)

- [ ] 1.1 Add `UiVerification` (`ran` with `UiScreenshot[]` + `observationCount` + `mounted` / `not-ui` / `unavailable` with reason) and `UiScreenshot` (`path` relative to the evidence dir, `label`) to `packages/types/src/index.ts`, doc-commented with the could-not-mount asymmetry; reuse `FindingElement` unchanged
- [ ] 1.2 Hand-written Zod for the additive field in `packages/protocol/src/index.ts`; parse test proves a legacy snapshot without the field validates unchanged
- [ ] 1.3 Red-first transport fidelity: extend the IPC field-fidelity test to assert `uiVerification` (screenshots included) survives the desktop transport — confirm it fails before the schema/dispatch carry the field
- [ ] 1.4 Add the `review.uiEvidence` protocol command (`{ reviewId, path } → { dataUrl } | not-found`); schema + dispatch signature only here, resolution in task 4

## 2. Core: classifier, budget, pure orchestration

- [ ] 2.1 `classifyUiSurface` in a new `packages/core/src/ui-verification.ts` — versioned (`UI_SURFACE_CLASSIFIER_VERSION = 1`), extensions `.tsx .jsx .vue .svelte .html .css .scss .less` plus `.ts`/`.js` under `renderer/`/`components/`/`ui/` path segments; unit tests cover positive, negative, and the segment heuristic
- [ ] 2.2 `ReviewIntelligenceBudget` gains `uiVerification: { maxTurns: 1 }` (frozen default); no other knob
- [ ] 2.3 `runUiVerification` pure orchestration (injected turn, same shape as `runFindingVerification`): classifier gate → config-absent `unavailable` → budget-refused `unavailable` → turn; malformed or failed turn output maps to `unavailable` with reason, never a fabricated clear; observations map to `FindingElement`s (anchor = implicated file, severity from impact, `agreement` concur 1/1, `verification` chip `reproduced` only when backed by an observed exec, else `inconclusive`)
- [ ] 2.4 Unit tests with a mock turn for every ladder rung: `not-ui` spends nothing, `unavailable` reasons are verbatim, could-not-mount yields the inconclusive disclosure and zero fabricated findings, a mounted run yields findings + `ran` status with screenshot refs

## 3. Adapters: the turn and the evidence directory

- [ ] 3.1 `createUiVerificationTurn` in `packages/adapters/src/ui-verification-backend.ts`, mirroring `createVerificationTurn` exactly (fresh capable session, output schema, exec observation with the paired/ambiguous rules); prompt carries the changed UI files + hunks, the `patchsetIntentToReviewIntent` projection as design intent, the afford-what-exists mounting ladder (project tests → storybook → dev server + installed automation → labelled static review), and the absolute evidence directory to write PNGs into
- [ ] 3.2 Resolve and create `<review persistence root>/ui-evidence/` in the backend; screenshot paths in the result are stored relative to it
- [ ] 3.3 Backend tests: schema round-trip, exec observation threading, a turn that wrote no screenshots yields `mounted: false`/static-labelled result

## 4. Pipeline + desktop wiring

- [ ] 4.1 Red-first guard-deletion control: pipeline test with a UI-file patchset and a stub turn asserting the verify-ui `finding` doc AND the `ran` status appear on the result — written and failing before 4.2
- [ ] 4.2 Wire `runUiVerification` into `pipeline.ts` deep-review branch after finding verification; append the observation doc to `admittedDocs`; stamp the status on the pipeline result; quick tier leaves the field absent
- [ ] 4.3 Thread the injected config through the desktop review backend the way `verificationConfig` flows; persist the status with the review snapshot so `review.load` reopens it intact
- [ ] 4.4 Implement `review.uiEvidence` in dispatch: read from the review's evidence directory only (an escaping path is not-found), return base64 data URL; missing file → not-found; test both

## 5. Renderer: the Flagged-lens strip

- [ ] 5.1 Verify-ui strip in `packages/ui/src/components/flagged.tsx`: `ran` → thumbnails via `review.uiEvidence` + observation count; `unavailable` → the one-line honest reason; `not-ui` or field absent → nothing rendered
- [ ] 5.2 DOM tests: additive proof (a review without the field renders exactly as today), unavailable line, thumbnails render from stubbed data URLs, missing-evidence note on a not-found image
- [ ] 5.3 Rule Zero control (red-first against any accidental gate): a review with unresolved verify-ui findings and an `unavailable` status still signs and publishes exactly as without the field

## 6. Docs + gate (same change, definition of done)

- [ ] 6.1 `docs/src/content/docs/developing/reference/delivery-order.md`: mark the wave-10 #183 entry delivered with the shipped shape (classifier, one budgeted turn, findings + honest status, evidence strip)
- [ ] 6.2 `docs/src/content/docs/using/guide/user-journey.md`: the review-intelligence walkthrough gains the verify-ui step (what it does, what "could not mount" means, where screenshots appear)
- [ ] 6.3 `pnpm check` green; push and verify the remote ref matches local HEAD; close #183 in the merge
