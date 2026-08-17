# Tasks — add-verify-ui (#183)

Red-first throughout: every guard lands with a demonstrated failure (write the
assertion against the unwired/absent behaviour, watch it fail, wire, watch it
pass). A control that cannot fail is the bug class delivery-order names.

## 1. Types + protocol (additive field, faithful transport)

- [x] 1.1 Add `UiVerification` (`ran` with `UiScreenshot[]` + `observationCount` + `mounted` / `not-ui` / `unavailable` with reason) and `UiScreenshot` (`path` relative to the evidence dir, `label`) to `packages/types/src/index.ts`, doc-commented with the could-not-mount asymmetry; reuse `FindingElement` unchanged
- [x] 1.2 Hand-written Zod for the additive field in `packages/protocol/src/index.ts`; parse test proves a legacy snapshot without the field validates unchanged
- [x] 1.3 Red-first transport fidelity: extend the IPC field-fidelity test to assert `uiVerification` (screenshots included) survives the desktop transport — confirm it fails before the schema/dispatch carry the field
- [x] 1.4 Add the `review.uiEvidence` protocol command (`{ reviewId, path } → { dataUrl } | not-found`); schema + dispatch signature only here, resolution in task 4

## 2. Core: classifier, budget, pure orchestration

- [x] 2.1 `classifyUiSurface` in a new `packages/core/src/ui-verification.ts` — versioned (`UI_SURFACE_CLASSIFIER_VERSION = 1`), extensions `.tsx .jsx .vue .svelte .html .css .scss .less` plus `.ts`/`.js` under `renderer/`/`components/`/`ui/` path segments; unit tests cover positive, negative, and the segment heuristic
- [x] 2.2 `ReviewIntelligenceBudget` gains `uiVerification: { maxTurns: 1 }` (frozen default); no other knob
- [x] 2.3 `runUiVerification` pure orchestration (injected turn, same shape as `runFindingVerification`): classifier gate → config-absent `unavailable` → budget-refused `unavailable` → turn; malformed or failed turn output maps to `unavailable` with reason, never a fabricated clear; observations map to `FindingElement`s (anchor = implicated file, severity from impact, `agreement` concur 1/1, `verification` chip `reproduced` only when backed by an observed exec, else `inconclusive`)
- [x] 2.4 Unit tests with a mock turn for every ladder rung: `not-ui` spends nothing, `unavailable` reasons are verbatim, could-not-mount yields the inconclusive disclosure and zero fabricated findings, a mounted run yields findings + `ran` status with screenshot refs

## 3. Adapters: the turn and the evidence directory

- [x] 3.1 `createUiVerificationTurn` in `packages/adapters/src/ui-verification-backend.ts`, mirroring `createVerificationTurn` exactly (fresh capable session, output schema, exec observation with the paired/ambiguous rules); prompt carries the changed UI files + hunks, the `patchsetIntentToReviewIntent` projection as design intent, the afford-what-exists mounting ladder (project tests → storybook → dev server + installed automation → labelled static review), and the absolute evidence directory to write PNGs into
- [x] 3.2 Create isolated review/patchset/run evidence namespaces under app user data; expose only the completed run namespace and prune superseded/old runs with bounded retention
- [x] 3.3 Backend tests: schema round-trip, exec observation threading, canonical confinement (final and intermediate symlink escapes), regular-file and 8 MiB byte bounds, namespacing, stale completion, and retention

## 4. Pipeline + desktop wiring

- [x] 4.1 Behavioral guard-deletion control: drive the injectable late-enrichment composer with a deferred verify-ui result, proving immediate all-concur delivery followed by completed observations/status
- [x] 4.2 Wire `runUiVerification` into desktop MAIN's live `runFlaggedReviewWithContextFeed`; stamp pending immediately, compose with `applyUiVerification`, and signal/poll late enrichment independently of adjudication; quick tier leaves the field absent
- [x] 4.3 Keep `FlaggedReview` transient like CI signal and `blockingStates`; record the declined persistence decision and bound evidence growth with patchset/run retention
- [x] 4.4 Implement `review.uiEvidence` as a realpath-confined, regular-file, stat-before-read, byte-bounded command; missing/escaping/symlinked-out → not-found, oversized → oversized

## 5. Renderer: the Flagged-lens strip

- [x] 5.1 Verify-ui strip in `packages/ui/src/components/flagged.tsx`: `ran` → thumbnails via `review.uiEvidence` + observation count; `unavailable` → the one-line honest reason; `not-ui` or field absent → nothing rendered
- [x] 5.2 DOM tests: additive proof (a review without the field renders exactly as today), unavailable line, thumbnails render from stubbed data URLs, missing-evidence note on a not-found image
- [x] 5.3 Rule Zero control: drive the real sign-resolution and publish command paths with pending and unavailable verify-ui states; both proceed exactly as without the field

## 6. Docs + gate (same change, definition of done)

- [x] 6.1 `docs/src/content/docs/developing/reference/delivery-order.md`: mark the wave-10 #183 entry delivered with the shipped shape (classifier, one budgeted turn, findings + honest status, evidence strip)
- [x] 6.2 `docs/src/content/docs/using/guide/user-journey.md`: the review-intelligence walkthrough gains the verify-ui step (what it does, what "could not mount" means, where screenshots appear)
- [x] 6.3 `pnpm check` green; push and verify the remote ref matches local HEAD; close #183 in the merge

## 7. Verify-ui pass #183 follow-up

- [x] 7.1 Fix late-enrichment delivery, pending/unavailable honesty, failed-branch transport, required budgets, method/exec/file certification, reported-line anchoring, evidence confinement/limits/namespacing/retention, behavioral composition coverage, and the real Rule Zero sign/publish controls
- [x] 7.2 `NX_DAEMON=false pnpm check` green; commit the follow-up with no push
