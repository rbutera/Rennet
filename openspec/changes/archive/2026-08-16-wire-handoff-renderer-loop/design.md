## Context

See proposal.md — Why. The main-process contract is finished and stable on `main`:

- `review.handoff.compose` — input `{ commandId, reviewId, dispositions: HandoffDisposition[] }`, output `{ bundle: ComposedHandoffBundle }`. Fail-closed: doubt returns the mechanical floor as `composed:false`.
- `review.handoff.run` — input `{ commandId, reviewId, bundle: ComposedHandoffBundle }`, output a discriminated `handoffRunOutputSchema` (success / refused / failed). The handler verifies the digest (`verifyComposedBundle`) and refuses tampered or stale bundles.
- `packages/ui` already has the pure `handoffPreview` view-model and presentational `HandoffPaper` component (unmounted), and `canvas/destination.ts` already models own-branch's batch destination as `"handoff"` alongside `"publish"`.
- `app.tsx` conventions: IPC via `bridge.invoke(name, input)`; navigation via `navigate(pushSurface({ kind, reviewId }))` with surface kinds `"draft"` and `"paper"` rendered inside the destination chrome; the own-branch paper is currently only the PR-submission `PublishSheet`.

## Goals / Non-Goals

Goals:

- One reachable path: own-branch review → handoff paper (composed preview) → run → outcome, all through the existing commands.
- Zero new main-process behavior; zero changes to the composition core or run handler.
- The renderer treats the composed bundle as opaque and immutable between compose and run.

Non-Goals:

- No narrated live progress (#71) — a plain pending state suffices.
- No post-run delta narration or traceMap consumption (#73).
- No redesign of the destination chrome or navigation model; reuse the draft/paper pattern as-is.
- No persistence of composed bundles across app restarts; a bundle is per-session working material (recompose is cheap and the digest guard makes staleness safe).

## Decisions

1. **A new surface kind `"handoff"`, sibling of `"paper"`.** The own-branch flow keeps its existing PR paper untouched; the handoff paper is a separate surface pushed on the same navigation stack. Alternative considered: overloading `PublishSheet` with a handoff variant — rejected, the artifacts differ in kind (a work order to run vs a PR to submit) and #109's "what you preview is what signs" mode-split argues for separate surfaces.
2. **Compose on surface entry, store `{ bundle, composedAt } | undefined` in app state.** Entering the handoff surface triggers `review.handoff.compose` with the review's effective dispositions (refined-if-kept, else raw — the same effectiveness rule the collation draft uses). While composing, the surface shows pending; on arrival the bundle renders via `HandoffPaper`. Alternative: compose eagerly on disposition change — rejected, wasted light-tier turns for a surface the reviewer may not open.
3. **Disposition changes invalidate the stored bundle.** The same state transitions that rebuild the collation draft clear the stored bundle, so re-entering the handoff surface recomposes. This implements the spec's "recomposing replaces the preview" scenario in the renderer; the digest/stale check in main remains the backstop, not the mechanism.
4. **The run action passes the stored bundle object untouched** to `review.handoff.run` and swaps surface state to pending → outcome. Outcome state is the command's discriminated union rendered directly (success / refused-with-reason / failed-with-error); no renderer-side reinterpretation. Alternative: re-fetching or re-validating in the renderer — rejected, verification is main's job and duplicating it is ceremony.
5. **Entry affordance lives where own-branch actions already live**: the collation-draft canvas / destination frame offers "Hand off to agent" alongside the existing sign path when the destination variant is own-branch and at least one actionable ask exists. Exact placement follows the existing `BatchDestination: "handoff"` modeling in `canvas/destination.ts`.
6. **`HandoffPaper` stays presentational.** Run button, pending, and outcome are passed as props (`onRun`, `runState`); the component gains no IPC knowledge, preserving its `@rennet/types`-only import rule and its existing DOM tests.

## Risks / Trade-offs

- [Compose latency on surface entry (one light-tier model turn)] → honest pending state; the fail-closed floor means a model failure still yields a runnable `composed:false` bundle rather than a dead end.
- [Reviewer changes dispositions mid-preview in another surface] → invalidation on disposition change (Decision 3) plus main's stale-review refusal; a refused run renders as refusal with reason, never a silent no-op.
- [State sprawl in the already-large `app.tsx`] → keep the handoff state to one `useState` cluster and push all derivation into pure `canvas/` functions (testable without DOM), matching the repo pattern.

## Migration Plan

Renderer-only, additive; no data or schema migration. Revert = revert the commit.

## Open Questions

None blocking. Copy details (button label, refusal wording) follow the docs style guide's honest-copy rule and can be settled in-diff.
