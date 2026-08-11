# Handoff-bundle composition (#72, Model Council M24) — build STATE

Branch: `feat/handoff-bundle-composition`, worktree `rennet-wt-bundle`, **stacked on
`feat/handoff-loop` @ `0427c91`** (#18, under dual review — expect a rebase). Owner:
handoff agent (same as #18).

## What #72 is

The light-tier AUTHORING step over #18's mechanical `buildHandoffBundle`: turn N terse
anchored asks into ONE coherent work order — ordered for execution sense, overlapping
asks merged, each group given a connective narrative — WITHOUT altering what was asked.
Makes the dead `handoff-bundle-composition` catalogue row (M24, Terra-medium) live.

## The safety design (answers "merge must not lose an ask" structurally)

The compose model turn returns **only a partition**: ordered groups, each citing ask
`dispositionIds` + a one-line `title`. It NEVER returns bodies. The composer
reconstructs every task's body VERBATIM from the trusted input by id. So the model
chooses order + grouping + prose and is *structurally incapable* of dropping or
rewriting a note. Then:

- **Deterministic validator** (`validateComposition`) rejects any partition that isn't a
  total cover of the ids: a dropped id, a duplicated id, an invented id, or an empty
  group → reject.
- **Fail-closed floor**: reject / turn-failed / no-seat → `mechanicalComposition` (one
  task per ask, pass-through list, `composed: false`). The always-present R9 floor.
- **Belt-and-braces guard**: every original body string must survive into the rendered
  prompt, else fall back. Reconstruction guarantees it; the guard asserts it.
- **Round-trip trace**: `traceMap` maps every input ask id → its task index, exactly
  once (the #72 acceptance). Ask ids are `d0..dN`, the ordinal in the deterministic
  mechanical order — the deliberate join key **#73** maps delta-review results through.

## Files

- `packages/types/src/index.ts` (appended, after the #18 handoff block): `ComposableAsk`,
  `ComposedTask`, `ComposedHandoffBundle`.
- `packages/core/src/handoff-compose.ts` (new): `asksFromBundle`, `buildComposePrompt`,
  `ComposePort`, `validateComposition`, `renderComposedPrompt`, `mechanicalComposition`,
  `composeHandoffBundle`. Pure, node-free (types + `sha256Hex`).
- `packages/core/src/handoff-compose.test.ts` (new): validator cases, valid-authoring
  merge (both bodies preserved), round-trip trace, all three floor fallbacks, empty
  bundle (no model call).
- `apps/desktop/src/main/handoff-compose-live.ts` (new): council-routed one-batched-turn
  compose port (Codex + Claude seats), mirrors `refine-comment-live.ts`.

## Wired + gated (DONE)

- **Protocol**: `review.handoff.compose` command + `composableAskSchema` /
  `composedTaskSchema` / `composedHandoffBundleSchema` (output schemas `z.ZodType<T>`
  for the IPC-strip guard).
- **Live port**: `apps/desktop/src/main/handoff-compose-live.ts` +
  `handoff-compose-live.test.ts` (8 tests: output-mapping, read-only session posture,
  Codex + Claude seats adopt a valid authoring, no-seat / malformed → floor).
- **Dispatch**: `review.handoff.compose` case + optional `composeBundle` dep, composed in
  `index.ts` (council-routed over the same claude+codex probes the refiner uses). 3
  dispatch tests (floor when unwired, delegates when wired + passes repoRoot, refuses
  stale id).
- **Gate GREEN**: full `NX_DAEMON=false pnpm check`, all 8 projects. **2090 passed / 7
  skipped**, **+24** over the `feat/handoff-loop` 2066/7 baseline (13 core + 8 live + 3
  dispatch). Diff is against `feat/handoff-loop`, NOT main.

## Seam — the ORDERING CONSTRAINT (baked into the protocol command doc)

Threading the composed bundle through #18's prepare→run consent-DIGEST is left as a
seam (#18 is under dual review). ⚠️ **The wiring MUST compose BEFORE the spend
disclosure, and the DISCLOSED artifact must BE the composed bundle (its `digest`)**,
because #18's `run` refuses on digest drift. Two ways to get it wrong:
- **Compose after disclosure** → digest drifts → every composed run dead-refuses.
- **Worse**: a `composed:false` fallback *after* disclosure → the human authorised the
  composed form but the mechanical form would run. (Sibling of the #74 signing-hold
  defect where a late model result swapped the payload mid-hold.)
So: compose once, disclose the composed bundle, bind consent to its digest, never
recompose between disclosure and run. This is written into the `review.handoff.compose`
command doc in `packages/protocol/src/index.ts` so the wirer inherits it.
