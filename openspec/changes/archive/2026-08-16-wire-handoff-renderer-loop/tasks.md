# Tasks

## 1. Renderer state and surface

- [x] 1.1 Add the `"handoff"` surface kind to the navigation surface union and its labels; pushing/popping it behaves exactly like `"paper"` (back returns to the draft/review surface it came from).
- [x] 1.2 Add handoff state to `app.tsx`: `composed: { bundle: ComposedHandoffBundle } | undefined`, `composeState: idle | pending | error`, `runState: idle | pending | outcome(handoffRunOutput)`. Disposition changes (the same transitions that rebuild the collation draft) clear `composed` and reset `runState`.
- [x] 1.3 On handoff-surface entry with no stored bundle: build the effective `HandoffDisposition[]` (refined-if-kept, else raw — reuse/extract the collation effectiveness rule as a pure `canvas/` function if not already shared) and `bridge.invoke("review.handoff.compose", ...)`; store the returned bundle. Pending and error states render honestly.

## 2. Entry affordance and paper

- [x] 2.1 Own-branch destination offers the handoff path ("Hand off to agent") alongside the existing sign path, following the `BatchDestination: "handoff"` modeling in `canvas/destination.ts`; hidden/disabled when the review is retrospective or has zero actionable asks.
- [x] 2.2 Mount `HandoffPaper` on the `"handoff"` surface, extended presentationally with `onRun`, `runState` props (no IPC in the component; `@rennet/types`-only imports preserved). Existing preview rendering (order, member asks, preview-only titles, honest `composed:false` floor) unchanged.
- [x] 2.3 Run action invokes `bridge.invoke("review.handoff.run", { commandId, reviewId, bundle })` with the exact stored bundle object; render the discriminated outcome directly: success state, refusal with reason, failure with error. No success rendering for any non-success outcome.

## 3. Tests (each guard red-proofable)

- [x] 3.1 DOM test: own-branch review with actionable asks → handoff affordance visible → entering the surface composes (mock bridge) and renders the bundle via `HandoffPaper`; the rendered order equals `bundle.tasks` order.
- [x] 3.2 DOM test: run passes the SAME bundle object the paper rendered (assert the mock received identical reference/digest); pending state shows while unresolved; success outcome renders as success.
- [x] 3.3 DOM test: a refused outcome renders as a refusal with its reason and no success state; a failed outcome renders as error.
- [x] 3.4 DOM test: changing a disposition after compose clears the stored bundle; re-entering the surface composes again (second mock call) and the run uses the fresh bundle.
- [x] 3.5 DOM test: retrospective review shows no handoff affordance.
- [x] 3.6 Red-proof each: verify each test fails when its guard is deleted (e.g. reorder before render, swap bundle before run, map refusal to success).

## 4. Docs and gate

- [x] 4.1 Update docs in the same change: product-and-vision "What is live" (the handoff loop is now live end to end through the renderer), delivery-order, agent-handoff.md ("the renderer's in-app trigger is the one remaining join" seam closes). A reader must not be left wrong.
- [x] 4.2 `NX_DAEMON=false pnpm check` green (exit 0 AND "Successfully ran target"); commit per-group with descriptive messages; report tip sha, diff stats, gate totals.
- [ ] 4.3 Do NOT self-review; the orchestrator owns review and merge. Archive this OpenSpec change on the real outcome post-merge.

## 5. Dual-review fixes (PR #325)

- [x] 5.1 C1 — clear the collation draft (and refine states) on review change, so review B never inherits review A's dispositions/handoff. Two-review regression test.
- [x] 5.2 C2 — capture the compose generation at run start; drop a run outcome that resolves after an invalidation or review change. Deferred-promise stale-run test.
- [x] 5.3 C3 — a blank effective body is not an actionable handoff ask (a neutral mark-read is not a work order); guards both `handoffDispositions` and the affordance predicate. Negative blank-comment test; fixtures author a real body.
- [x] 5.4 C4 — mount the handoff surface as a modal (reusing `.publish-sheet-backdrop` + dialog semantics), not a bare section in document flow. DOM shell assertion.
- [x] 5.5 O1 — the run button is disabled on any terminal outcome; a fresh compose (invalidation) is the path to run again.
- [x] 5.6 C5 — a failed compose is not a re-entry dead-end: leaving the surface resets the error to idle so re-entry recomposes. Failure→back→re-entry test.
- [x] 5.7 C6 — a failed run renders the files it mutated before failing (`filesTouched`), never a bare error.
- [x] 5.8 C7/N1 — the pending assertion is real (deferred promise, asserts pending + disabled before resolving); stale header comment corrected.
