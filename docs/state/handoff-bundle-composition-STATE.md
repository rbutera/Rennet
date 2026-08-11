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

## Still TODO (blocked / pending answers)

- ⚠️ **Deps**: the worktree has NO `node_modules`; lead ⛔'d `pnpm install`. Nothing
  typechecked or gate-run yet. Awaiting the lead's provisioning call.
- **Protocol + dispatch**: a `review.handoff.compose` command returning the composed
  bundle (additive, useful in both integration scopes). Awaiting the lead's scope call:
  compose-command-only vs threading the composed bundle through #18's prepare→run.
- **Live port test** + **dispatch test**.
- **Gate** vs the branch baseline **2066 / 7** (feat/handoff-loop), delta reported.

## Seam

Threading the composed bundle through prepare→run's consent-DIGEST binding is #18 code
under dual review. Left as a documented seam unless the lead pulls it in-scope.
