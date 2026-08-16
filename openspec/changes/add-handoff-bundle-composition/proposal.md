## Why

Issue #72 asks for the authoring step that turns N staged review notes into ONE coherent work order for a coding harness in own-branch (handoff) mode — Model Council job **M24**. The **composition core already shipped** (commit `d1b41e6`, on `origin/main`): `composeHandoffBundle` orders and groups the asks, merges overlapping ones, and narrates each group, all under a safety law that makes it structurally incapable of dropping or rewriting what the reviewer asked. The IPC command `review.handoff.compose`, the types, the protocol schemas, the council routing, and the live Codex/Claude seats are all in the tree.

What is NOT in the tree is the wiring that makes any of it observable or consequential:

- **The composed order dies at the run boundary.** `review.handoff.run` rebuilds a *mechanical* bundle straight from the dispositions and executes THAT — it never reads the composed bundle. So the write session runs the un-ordered, un-merged prompt while the composition sits unused, in direct violation of the ordering contract the protocol's own doc-comment already spells out: *compose once, then run the composed bundle*. This is the headline failure: the feature computes a better work order and then throws it away.
- **Nothing shows the reviewer what will be handed off.** No UI consumes `review.handoff.compose` or renders a `ComposedHandoffBundle`. The composed bundle's own type comment promises it is "previewed on the paper at journey stage 6", but that preview does not exist — the reviewer signs a handoff they cannot see composed.
- **No promoted spec governs the composition.** Only `model-council` names M24 as a routed job; the composition *behaviour* — the total-cover law, the fail-closed floor, verbatim-body reconstruction, the preview-only title — is un-specced. Code-first is fine; leaving it un-specced is not.

This change promotes the shipped capability to a spec of record and builds the two wirings that make it real: run the composed bundle, and show it before it runs.

## What Changes

- **Run the composed bundle, not a re-derived mechanical one.** `review.handoff.run` SHALL execute the exact composed bundle that `review.handoff.compose` produced (its ordered, grouped prompt, bound by its `digest`). Once a composed bundle exists for a run, the write session SHALL NOT recompose it, SHALL NOT rebuild a mechanical bundle from the raw dispositions, and SHALL NOT let a `composed:false` fallback silently stand in for a bundle that was prepared as `composed:true`. The digest is the binding: what was composed and what runs are provably the same bytes.
- **A stage-6 handoff preview on the paper.** The own-branch paper SHALL render the `ComposedHandoffBundle` before the reviewer runs it — the ordered tasks, each group's member asks, and each group's model-authored `title` as PREVIEW-ONLY metadata. The preview reads through the same `composed` flag the core exposes, so a mechanical-floor bundle is shown honestly as un-composed rather than dressed up as authored.
- **Promote `handoff-bundle-composition` to a capability spec.** Document the already-shipped composition law as requirements of record: asks carry stable ids; a valid partition is a TOTAL COVER of those ids; the model returns only order + grouping + a title and never a body; bodies are reconstructed verbatim by id; any doubt falls closed to the mechanical pass-through floor (`composed:false`); the model's title never enters the executable prompt.

## Capabilities

### New Capabilities
- `handoff-bundle-composition`: the M24 authoring step over the mechanical `HandoffBundle` — total-cover partition validation, verbatim-body reconstruction, the fail-closed mechanical floor, preview-only titles, and the two consequential wirings (run executes the composed bundle under its digest; the paper previews it at stage 6).

### Modified Capabilities
<!-- None require a spec delta. `model-council` already lists the handoff-bundle job as a routed light-tier job (spec.md line 11), so routing is covered and is referenced, not changed. `review.handoff.run` / the #18 handoff loop are themselves un-specced today, so "run executes the composed bundle" is a NEW requirement of the new capability, not a modification of an existing one. -->

## Impact

- **`apps/desktop/src/main/dispatch.ts`** — the `review.handoff.run` handler stops rebuilding a mechanical bundle from `input.dispositions` and instead runs the composed bundle prepared for that run; the compose→run ordering is enforced at the boundary (digest-bound). No change to the write turn itself or to the delta-capture that follows it.
- **`packages/protocol/src/index.ts`** — `review.handoff.run`'s input shape carries (or references) the composed bundle to run, so the command cannot execute a different bundle than the one composed. Hand-written Zod, reusing `composedHandoffBundleSchema`.
- **`packages/ui/src/canvas/publish.ts` + the paper component** — a pure preview view-model over `ComposedHandoffBundle` (tasks in order, member asks, preview-only titles, the `composed` flag surfaced), layer:ui, `@rennet/types` only.
- **`packages/core/src/handoff-compose.ts`** — unchanged. The composition core is the shipped `d1b41e6` code; this change specs it and wires its output, it does not rewrite it.
- **Out of scope, named:** `traceMap` consumption for delta re-review (mapping harness results back to source disposition ids) is **issue #73's** territory. The composed bundle already exposes `traceMap` as the forward hook #73 will consume; this change specs that the hook exists and is correct, and does nothing more with it.
