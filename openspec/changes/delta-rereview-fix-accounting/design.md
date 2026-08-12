# Design — delta-rereview-fix-accounting (N2 / #73)

## The one principle: the account is deterministic; prose only rephrases it

The delta account is not an LLM feature with a deterministic fallback. It is a **deterministic feature** with optional LLM prose on top. Every fact the reviewer relies on — which asks were addressed, which were ignored, what the agent did beyond the asks — is computed by trace-map arithmetic over data that already exists, with **no model call**. The light-tier seat (Model Council M25) only turns that structured account into readable sentences, and if it is unavailable or budget-exhausted, the structured account still renders in full. This is the accountability guarantee: a scope-creep detector that could hallucinate is worthless.

## What already exists (do not rebuild)

- The **carry** is shipped: `carryDispositionsByLineage` runs in the `PatchsetActivated` fold (`packages/core/src/index.ts:613`); the handoff run result already carries `carriedForward` and `orphaned` (`apps/desktop/src/main/dispatch.ts:1061`). Read these; do not add carry logic.
- The **disposition-id trace** — each staged ask in the handoff bundle carries a disposition id, and the returned patchset's hunks trace back to it. This is the map that answers "was this ask addressed."
- The **lineage identity** (`carried`/`orphaned` from the carry) tells you which prior hunks survived byte-identically or via a verified rename.

## The three computations (all deterministic)

1. **What moved, per ask.** For each staged disposition: locate its target hunk(s) in the prior patchset, follow the disposition-id trace + lineage into the new patchset.
   - *Untouched* — the target's occurrence carried byte-identically (it is in `carried`, unchanged).
   - *Addressed* — the target's bytes changed (not in `carried`; a new hunk traces to its disposition id).
   - *Partially addressed* — a multi-hunk ask where some targets changed and some carried unchanged.
2. **Beyond your asks.** Every hunk in the new patchset that traces to **no** staged disposition id and is **net-new** (not a carried prior hunk). These are surfaced loudly — they are the changes nobody asked for.
3. **Reconciliation invariant.** Every new-patchset hunk lands in exactly one bucket: addressed-an-ask, or beyond-asks, or a carried-unchanged prior hunk. A hunk in none of them is a bug in the skeleton, not a silent drop — assert the partition is total.

## Rendering (Zone A)

- The account renders at the **top of the successor canvas** (journey stage 7), above the diff, as the entry to delta re-review. Wireframe reference: `06-review-heart` is the review canvas the successor canvas reuses; `17-flow-overview` places stage 7. **Where the wireframe frames and the issue prose disagree on placement, the wireframe wins** — if `06`/`17` show the delta account somewhere other than top-of-canvas, follow the frame and say so in the PR.
- Each summary item **anchors**: a `canvas.focus`-style tap scrolls the diff to the moved hunk(s) and pulses them.

## Model-free proof

The red-then-green test stubs the M25 light seat to throw, then asserts the full structured account (2 addressed, 1 untouched, 1 beyond-asks) still renders. If the account degrades or errors when the model is gone, the deterministic skeleton is not actually model-free and the guarantee is broken.

## Rule Zero

The account is **informational**. It never blocks re-review, never gates sign, never demands acknowledgement. Surfacing beyond-asks loudly is a feature (it shows the reviewer more of the truth); it is not a consent step.
