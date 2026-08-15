# Handoff-bundle composition, wired live (issue #72, Model Council M24)

## Why

Issue #72 names the authoring step between the staged dispositions and the coding harness: compose N refined asks into ONE coherent work order, because a raw list of terse anchored comments produces "the agent did N things near my comments" instead of "the agent addressed my review". On current `main` that step is **built but dark**. The core composer (`packages/core/src/handoff-compose.ts`), the council-routed live seat (`apps/desktop/src/main/handoff-compose-live.ts`, job `handoff-bundle-composition`, M24 light tier) and the `review.handoff.compose` IPC command all exist and are unit-proven — but nothing calls them. The renderer never invokes the compose command; `review.handoff.run` rebuilds and executes the MECHANICAL bundle, so the composed prompt never reaches the coding agent; the paper never previews the composed narrative; and the bundle's `traceMap` has zero consumers. The docsite names the gap itself ("the handoff composer is a separate command whose result is not yet passed into the acting run" — collation-and-signing, What is live). This change closes exactly that gap, to exactly #72's acceptance.

## What Changes

- **The collation draft canvas (own-branch mode) invokes composition.** Per R40 and #101, #72's home is the collation draft canvas, not a standalone surface. In `own-branch` (handoff) mode the renderer runs `review.handoff.compose` over the staged set and shows the result: the composed groups in execution order, each citing its member asks, with the model's one-line title as preview metadata and an honest `composed: false` state when the mechanical floor answered.
- **The paper previews the composed narrative (journey stage 6).** The own-branch handoff preview renders the composed work order — grouped tasks, mechanically-derived headings, the reviewer's bodies verbatim — as the exact prompt contract that will be handed to the coding harness. Nothing unadjudicated appears: composition never alters WHAT was asked, only how it reads.
- **The acting run executes the previewed composition.** `review.handoff.run` accepts the composed bundle and executes ITS prompt, verifying the composed bundle's digest against a recomposition-free recheck (the digest already binds the ordered composed structure) and falling back to the mechanical bundle when no composition is supplied or the check fails. Today's behaviour (mechanical prompt) remains the floor, never removed.
- **The trace map round-trips.** The run result carries the executed bundle's `traceMap` (every source disposition id → its composed task), so the successor review / delta re-review (stage 7) can map results back to the dispositions that asked for them. Round-trip invariant: every input ask id appears exactly once in the trace map.
- **The compose turn is budget-gated and trace-logged.** The live composer currently resolves its council seat but discards the resolution trace and consumes no invocation budget. It gains both: one batched light call charged against the shared invocation budget (an exhausted budget degrades to the mechanical floor — a complete bundle, honestly marked `composed: false`, never a fabricated composition), and the council resolution trace recorded with the compose outcome.

**Out of scope** (adjacent, deliberately untouched — follow-ups, not folded in):

- Making the renderer drive the full write-enabled handoff **run** loop and delta recapture end-to-end — #18 owns the loop surface; this change only guarantees that when the run happens, it executes the previewed composition.
- The unsurfaced reopened-disposition case in the lineage carry (#266).
- Any dependency-DAG ordering signal beyond what the compose prompt already asks the model for (execution-sense ordering, anchor adjacency); a deterministic DAG input would be new machinery with its own issue.
- The orchestrator proposing draft edits on L3 (#101's wider canvas scope).

## Capabilities

### New Capabilities

- `handoff-bundle-composition`: The light-tier authoring step over the mechanical handoff bundle — partition-only model output (order + grouping + preview-only titles, never bodies), total-cover validation, verbatim body reconstruction, the fail-closed mechanical floor, the content digest, the source-disposition trace map and its round-trip into the run result, council routing (M24, one batched call, budget-gated, trace-logged), the collation-draft invocation in own-branch mode, and the rule that the run executes the previewed composed prompt.

### Modified Capabilities

- `destination-frame`: The own-branch variant's requirement sharpens: the handoff framing SHALL present the composed work order (when composition succeeded) as the exact outbound prompt contract, with the previewed narrative equal to what the run executes — extending the existing "preview exactly what will leave the machine" guarantee from the publish payload to the handoff prompt.

## Impact

- **`packages/core`** — `handoff-compose.ts` gains no semantic change; `handoff-loop.ts`'s run input widens (additively) to carry an optional composed bundle whose prompt the turn executes, digest-checked. Compose-live's budget/trace accounting lands where the seat is resolved.
- **`packages/protocol`** — additive: `review.handoff.run` input accepts the optional composed bundle; the run output carries the executed bundle's trace map. Existing command shapes unchanged; a client that never composes behaves exactly as today.
- **`packages/types`** — additive fields only (trace map on the run result; no existing field changes).
- **`apps/desktop`** — `dispatch.ts` run handler prefers a supplied composed bundle over the mechanical rebuild after digest verification; `handoff-compose-live.ts` charges the shared invocation budget and records the resolution trace.
- **`packages/ui`** — collation draft canvas (own-branch mode) gains the compose invocation and grouped preview; the paper's handoff variant renders the composed narrative. `@rennet/ui` keeps importing only `types`/`protocol` (R20); all compose execution stays behind the typed command.
- **Invariants preserved**: the batch view remains byte-identical to the payload (disposition-ui) because composition is content-preserving by construction; R28 patchset immutability and the R38 all-or-nothing sign are untouched; Rule Zero — no new consent step anywhere (the mechanical floor is a fallback, not a gate).
