## Context

The composition core landed in `d1b41e6` ("compose the handoff bundle into a narrative before the agent reads it"), on `origin/main`. Verified against the tree (2026-08-15):

- **`packages/core/src/handoff-compose.ts`** (353 lines, node-free). `asksFromBundle(bundle)` stamps each mechanical task with a stable id (`d${index}`, its ordinal in the deterministic order). `buildComposePrompt(asks)` hands the model the asks WITH ids and constrains it to return only a partition (order + grouping + a per-group title), never bodies. `validateComposition(asks, proposal)` requires a TOTAL COVER — no dropped, duplicated, or invented id. `renderComposedPrompt(tasks)` builds the executable work order with per-task headings derived MECHANICALLY from the trusted ask paths and every instruction body VERBATIM. `mechanicalComposition(bundle)` is the fail-closed floor (one task per ask, `composed:false`). `composeHandoffBundle(bundle, port)` runs one injected turn and, on unavailable / failed / thrown / invalid-partition, returns the floor; on a valid partition it reconstructs bodies from the trusted input by id, then belt-and-braces asserts every original body survived into the rendered prompt before returning `composed:true`.
- **`packages/types/src/index.ts`** — `HandoffBundle` (#18: reviewId, patchsetId, tasks, prompt, digest), `ComposableAsk extends HandoffTask { id }`, `ComposedTask { title, sourceDispositions, asks }`, `ComposedHandoffBundle { reviewId, patchsetId, tasks, prompt, digest, composed, traceMap }`.
- **`packages/protocol/src/index.ts`** — `composableAskSchema` / `composedTaskSchema` / `composedHandoffBundleSchema`, and the command `review.handoff.compose` (input: dispositions; output: the composed bundle). Its doc-comment already states the ordering contract this change enforces.
- **`apps/desktop/src/main/handoff-compose-live.ts`** — `createLiveComposeBundle` council-resolves the seat and injects the real `ComposePort`; `dispatch.ts` handles `review.handoff.compose` (mechanical bundle → `deps.composeBundle` → composed, else floor); `index.ts:1813` wires it.
- **`packages/core/src/model-council.ts`** — job `handoff-bundle-composition` = M24, light tier, batched, catalogue row 15; assignment defaults Codex `gpt-5.6-terra`/medium, Claude `sonnet-5`/medium. `model-council`'s promoted spec already lists it as a routed job.

The gap is downstream of all this. `review.handoff.run` (`dispatch.ts:1115`) rebuilds a mechanical bundle from `input.dispositions` via `buildHandoffBundle` and runs `deps.runHandoffTurn({ repoRoot, bundle })` — the run turn takes only a **prompt** (`HandoffRunInput.prompt`, "the task contract") and never sees the composed bundle. And no `packages/ui` code renders a `ComposedHandoffBundle`; the own-branch paper today previews a `PrSubmission` (`composePrSubmission` in `publish.ts`), a different artifact for a different destination.

## Goals / Non-Goals

**Goals:**
- Promote the shipped composition behaviour to a `handoff-bundle-composition` capability spec of record.
- Make the write turn execute the *composed* bundle, honoring "compose once, run that bundle" — digest-bound so what ran equals what was composed.
- Give the reviewer a stage-6 preview of the composed bundle on the own-branch paper, honest about whether it was authored (`composed:true`) or the mechanical floor.

**Non-Goals:**
- **`traceMap` consumption / delta re-review map-back — this is issue #73.** The composed bundle exposes `traceMap` (every input ask id → its task index, each id exactly once) as the forward hook; this change proves the hook is present and correct and consumes it nowhere. Building the delta-review reback is #73.
- **Rewriting the composition core.** `handoff-compose.ts` shipped in `d1b41e6`; the safety law, the floor, and the prompt builders are not touched. This change specs and wires them.
- **Changing the composition safety law.** The model still returns only a partition; bodies are still reconstructed verbatim; the title is still preview-only. No new model authority is granted at the executable boundary.
- **A consent ceremony.** Rule Zero holds — clicking run IS the human act. The digest binds compose to run for *integrity* (same bundle), not as an approval gate.

## Decisions

**1. Run executes the composed bundle, bound by its digest.** The `review.handoff.run` contract changes so the bundle it runs is the composed one, not a re-derivation. The run's executable prompt is `ComposedHandoffBundle.prompt` (the ordered, grouped, verbatim work order `renderComposedPrompt` already produces), and the run is bound to `ComposedHandoffBundle.digest` so a run cannot silently execute a different bundle than the one composed. Concretely: `review.handoff.run` accepts the composed bundle (or the digest of the bundle prepared for this run) rather than re-deriving from `dispositions`; if a composed bundle was prepared, a mechanical rebuild at run time is refused. The mechanical floor is still a legitimate thing to RUN — but only when it is the bundle that was composed (`composed:false` because the model was unavailable/failed), never as a silent substitute for a `composed:true` bundle that was prepared and then lost.

**2. Compose stays a separate, idempotent step; run consumes its output.** `review.handoff.compose` remains the one place the model turn happens (it spends exactly one light-tier compose turn and posts nothing). Run does not compose. This preserves the batched-job shape (compose once for the whole bundle) and the ordering contract: recomposing between compose and run — or letting run's own mechanical rebuild stand in — is precisely what makes the write session execute different work than was previewed. The spec forbids both.

**3. The stage-6 preview is a pure view-model over the composed bundle.** A `handoffPreview(bundle: ComposedHandoffBundle)` in layer:ui (`@rennet/types` only) yields the ordered tasks, each task's member asks (path, anchor, effective body), and each task's `title` marked PREVIEW-ONLY, plus the `composed` flag surfaced verbatim. The paper renders this; it never re-derives order or re-runs the model. "What you see is what leaves" holds because the preview reads the same `tasks`/`prompt` the run executes. A mechanical-floor bundle (`composed:false`, empty titles) renders as an honest un-composed list, never dressed as authored prose.

**4. The model's title never crosses into the executable prompt — restated as a spec invariant.** The core already enforces this structurally (`mechanicalHeading` derives the executable per-task heading from trusted ask paths; the title is preview metadata). The spec pins it: a model-authored line can reach the human's eyes on the paper but can never reach the coding agent's work order, so a partition that validates cannot smuggle an invented instruction through the title field.

**5. The floor is the always-present contract, everywhere.** Compose falls closed to the mechanical pass-through on any doubt; run executes whatever bundle it was given (composed or floor) but never invents order; the preview shows the floor as a floor. At no point does the system fabricate a composition, drop an ask, or run an order nobody composed. This is the single law the three surfaces share.

## Verified against origin/main (2026-08-15)

Stated so the reviewer does not re-derive them:

- **Composition core is shipped and complete**, not scaffolding: `composeHandoffBundle` runs the turn, validates the total cover, reconstructs verbatim, and asserts body-survival before returning `composed:true` (`handoff-compose.ts:306`). The mechanical floor is returned on every failure branch including a thrown port.
- **Run ignores it today**: `review.handoff.run` builds `buildHandoffBundle({ reviewId, patchset, dispositions })` and runs that (`dispatch.ts:1122`). There is no reference to the composed bundle in the run path. This is the behavioural gap, not a subtlety.
- **The run turn is prompt-driven**: `HandoffRunInput = { cwd, prompt, signal? }` (`handoff-loop.ts:265`). Feeding it the composed prompt is a change of *which* prompt, not a new turn shape.
- **No UI consumes the composed bundle**: a repo-wide search finds `ComposedHandoffBundle` / `review.handoff.compose` only in types, protocol, core, and the desktop main-process wiring — zero renderer references.
- **`traceMap` is produced but consumed nowhere** (no reader in `packages/core`), confirming #73 is genuinely separate and correctly left out.

## Risks / Trade-offs

- **The behavioural fix is the whole point and is easy to under-test.** A happy-path handoff passes whether run executes the composed order or the mechanical one. Mitigation: the spec's run scenario asserts the *order* the write turn receives equals the composed order (e.g. a two-ask bundle the model reversed must reach the turn reversed), and red-proofs by restoring the mechanical rebuild and watching the order assertion fire.
- **Digest binding could reject a legitimately-recomposed bundle.** Trade-off: that is the intended direction — a bundle whose composition changed between prepare and run is exactly the case the ordering contract forbids running. The honest outcome is re-prepare, not run-anyway.
- **The floor must remain runnable.** A guard that refused to run any `composed:false` bundle would break the fail-closed path (model unavailable → floor → still must be runnable). Mitigation: the refusal is scoped to "a mechanical rebuild silently replacing a prepared composed bundle", not "running a floor that was legitimately composed as the floor".
- **The preview must not become a second publish path for private bodies.** The composed bundle carries effective disposition bodies (the reviewer's own words) — it is handed to the reviewer's own harness, not published to a PR, so this is not a privacy egress. Named here so it is a considered decision, not an oversight: the preview renders bodies the reviewer wrote, on the reviewer's own paper, bound for the reviewer's own branch.
