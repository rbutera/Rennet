# Design — wiring handoff-bundle composition live

## Context

See proposal.md for motivation. The load-bearing current-state facts:

- **The composition core is done and unit-proven.** `packages/core/src/handoff-compose.ts` implements the whole safety law: `asksFromBundle` (stable `d<N>` ids in the mechanical order), `buildComposePrompt` (partition-only contract), `validateComposition` (total cover: no dropped / duplicated / invented id), verbatim body reconstruction by id, `renderComposedPrompt` (mechanical headings from ask paths; the model's title is preview-only and never enters the executable prompt), `composedDigest` (sha256 over the ordered composed structure), `mechanicalComposition` (the fail-closed floor, `composed: false`), and a belt-and-braces assert that every non-empty body survived into the rendered prompt.
- **The live seat is done.** `apps/desktop/src/main/handoff-compose-live.ts` resolves the council job `handoff-bundle-composition` (M24, light tier, `batched`) via `resolveAssignment`, builds a Codex (`codex exec` + `COMPOSE_OUTPUT_SCHEMA`) or Claude (structured-output session) `ComposePort`, and routes through `composeHandoffBundle`. It currently **discards the resolution trace** and **consumes no invocation budget**.
- **The command exists but has no caller.** `review.handoff.compose` is registered in `apps/desktop/src/main/dispatch.ts` and `packages/protocol` (schemas for `ComposedHandoffBundle`, `ComposedTask`, `traceMap`); `packages/ui` contains zero references to it or to `ComposedHandoffBundle`.
- **The run ignores composition.** `review.handoff.run` rebuilds the mechanical bundle from `(reviewId, dispositions)` and hands `deps.runHandoffTurn({ repoRoot, bundle })` the mechanical prompt. `traceMap` has no consumer anywhere.
- **UI substrate.** The collation draft (`packages/ui/src/canvas/collation.ts`) is the ordered item model (raw/refined bodies, merge/split/reorder/withdraw); `canvas/destination.ts` maps `own-branch → "handoff"`; `components/collation-draft-canvas.tsx` already hosts the own-branch composer for the PR draft (#74/M26) with transient status state rounded through `app.tsx`; `components/publish-sheet.tsx` is the paper. The #74 PR-draft flow (renderer invokes a command, holds the draft in app state, paper renders it, staleness clears it) is the precedent this change copies.
- **Budget semantics** (#260/#269, `packages/core/src/invocation-budget.ts`): an absent budget object runs ungated; an exhausted budget refuses visibly and the runner falls to its deterministic floor.

## Goals / Non-Goals

**Goals:**

- One coherent renderer flow: compose on the collation draft (own-branch mode) → preview the composed narrative on the paper → the run executes exactly the previewed prompt.
- Staleness handled the same way comment refinement handles it: a composition is bound to the staged set it was computed from and is discarded when that set changes.
- Budget + trace accounting on the compose turn without changing the fail direction (floor on refusal, never a block, never a fake composition).

**Non-Goals:**

- No new renderer surface for driving the handoff **run** loop end-to-end or the delta recapture UX (#18's surface; #266's reopened-case surfacing).
- No change to composition semantics, the compose prompt, or the council catalogue (M24's row, tiers, and tables already exist).
- No deterministic dependency-DAG ordering input (follow-up if ever wanted; the compose prompt already instructs execution-sense ordering).
- No RSP doc type for the composed bundle — it stays a command result, like refinement (`RefineOutput`) does on the live path.

## Decisions

**D1 — The composition is renderer-held derived state, not an event or a disposition mutation.**
Like #74's `prDraft`, the composed bundle lives in `app.tsx` state keyed by a signature of the staged set (the mechanical bundle's `digest` is exactly this — deterministic over the ordered asks). Any draft edit that changes the staged payload changes the mechanical digest, which invalidates the held composition (mirrors refinement's raw-body signature check). Alternative rejected: persisting the composition as an L2/L3 event — it is a derived reading of L2, rebuildable at will, and R17's event sourcing is for durable truth, not caches.

**D2 — The run takes the composed bundle in its input; verification is recomputation, not trust.**
`review.handoff.run`'s input gains an optional `composed: ComposedHandoffBundle`. The handler still rebuilds the mechanical bundle from `(reviewId, dispositions)` — that rebuild is the trusted reference. Verification: (a) recompute the composed digest over the supplied tasks and compare to `composed.digest` (integrity); (b) check the supplied bundle's ask set is a total cover of the rebuilt mechanical bundle's asks with byte-identical bodies (staleness — `validateComposition` reused with `asksFromBundle(mechanical)` plus a body-equality check). Pass → `runHandoffTurn` receives the composed prompt. Fail → the run **refuses** with a reason naming the stale/corrupt composition (parallel to the existing R28 immutability refusal), because silently executing the mechanical prompt would break "the preview is what runs". Absent `composed` → today's mechanical path, byte-for-byte unchanged. Alternative rejected: passing only a digest and recomposing server-side — recomposition spends a second model turn and can legitimately produce a different partition, so the executed prompt could differ from the previewed one.

**D3 — Trace map rides the run result.**
`HandoffRunResult` gains the executed bundle's `traceMap` (and `composed: boolean`), additive. The mechanical path emits the mechanical composition's trace map (one ask per task), so the field is total and downstream delta tooling never branches on absence. No consumer beyond surfacing is built here (stage-7 mapping UI is #18/#266 territory); the contract just guarantees the data survives the run boundary.

**D4 — Budget and trace land in the composition root, not in core.**
`createLiveComposeBundle`'s deps gain an optional `budget?: InvocationBudget` and an outcome recorder. Before running the turn: `budget.tryConsume("handoff-bundle-composition")`; a refusal skips the turn and the core router returns the floor (`composed: false`) — matching #260's law (absent budget = ungated; exhausted budget = visible floor, never a block). The `resolveAssignment` resolution (already computed, currently discarded) is returned alongside the bundle in the command output (`resolution` summary: harness, model, effort, trace line), so the UI can answer "why did this model run" the same way pipeline provenance does. Core `handoff-compose.ts` stays pure and unchanged.

**D5 — The paper renders the composed narrative from the same object the run will execute.**
`publish-sheet.tsx`'s own-branch handoff framing takes the held `ComposedHandoffBundle` and renders `tasks` (mechanical headings, member asks with verbatim bodies, preview titles as secondary metadata) — not a re-derivation. The prompt string previewed IS `composed.prompt`. `composed: false` renders the pass-through list with an explicit "not model-composed" marker (honest floor, R10/§floor doctrine). The existing byte-equality guarantee (preview bytes = staged payload bytes) is untouched for the publish path; the handoff path's analogous guarantee is prompt identity via D2.

**D6 — Compose is user-invoked, not automatic on every draft edit.**
A "Compose" action in own-branch mode (plus re-compose after invalidation), mirroring "Refine to post". Automatic background composition on every edit would spend a model turn per keystroke burst and add a debounce policy question with no product need yet. The mechanical floor is always available synchronously for preview before the first compose.

## Risks / Trade-offs

- [Stale-composition refusal could annoy: edit → forget to recompose → run refuses] → The refusal reason names the fix ("the draft changed since composition; recompose"), and D1's invalidation means the UI already shows the composition as stale before the user reaches run. This is an integrity refusal, not a consent gate (Rule Zero: nothing asks permission; it refuses to execute something other than what was shown).
- [Body-equality staleness check is strict: an ask-context (diff-context) change alone re-keys the mechanical digest] → Correct behaviour: context is part of what the agent executes; a changed patchset must recompose anyway.
- [Budget threading: the ad-hoc compose command runs outside a pipeline run, so a per-review shared budget object may not exist at dispatch time] → D4 makes the budget optional with #260 semantics (absent = ungated), so wiring can start ungated-but-trace-logged and tighten when the desktop threads a per-review budget to ad-hoc commands generally; the spec's exhausted-budget scenario is satisfied whenever a budget IS present.
- [Two sources of truth for the preview (UI-held bundle vs run-side rebuild)] → D2's verification makes divergence loud rather than silent; the digest is content-addressed so equality is byte-meaningful.
- [`renderComposedPrompt` already exists; UI must not re-render its own variant that drifts] → The paper previews `composed.prompt` (the string itself) for the prompt view and uses `tasks` only for the structured reading; a DOM test asserts the previewed prompt string equals the bundle's `prompt`.

## Migration Plan

Additive throughout: new optional command input/output fields, new UI affordances behind the own-branch mode that already exists. A client that never composes hits identical behaviour to today. No data migration, no event-schema change, no rollback hazard beyond reverting the change.

## Open Questions

- Whether the compose resolution summary should also appear on the paper (vs only in a dev/diagnostics surface) — presentational; safe to decide at build time.
- Whether re-compose should be offered automatically when a held composition is invalidated (one-click vs auto) — interaction polish over the same machinery.
