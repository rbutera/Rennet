## Why

The coding-agent handoff loop is fully built behind main-process commands — `review.handoff.prepare`, `review.handoff.compose`, and the digest-bound `review.handoff.run` (merged in #323) — and the `HandoffPaper` preview component exists in `packages/ui`. But nothing in the renderer calls any of it: `app.tsx` has no compose call, no mounted `HandoffPaper`, and no run action. The own-branch destination only offers PR submission. The user cannot hand their review notes to a coding agent from the app at all, which is the last gap in issue #72 and the reason the docs still say "the renderer's in-app trigger is the one remaining join."

## What Changes

- The own-branch destination gains the handoff path alongside PR submission: from an own-branch review with actionable dispositions, the reviewer can compose the handoff bundle, see it previewed, and run it.
- Stage-6 paper: the renderer calls `review.handoff.compose` and mounts the existing `HandoffPaper` component to preview the exact composed bundle (ordered tasks, member asks, preview-only titles, honest `composed` flag) before any run.
- A run action invokes `review.handoff.run` with the exact previewed bundle (digest-bound; the renderer never rebuilds or mutates it) and surfaces the run outcome — success, refusal, or failure — in the destination chrome. Run status is shown honestly from the command's discriminated outcome; no state claims work happened when it didn't.
- No new main-process behavior: this change is renderer wiring over commands that already exist. Compose failures fall back exactly as the core does (the mechanical floor arrives as `composed:false` and is previewed honestly as un-composed; it still runs).
- No consent ceremony is added (Rule Zero): running the handoff is one action from the preview, like signing is for the PR paper. The preview is the product surface (see what will be handed off), not an approval gate.

## Capabilities

### New Capabilities

_None. The composition, preview semantics, and digest-bound run are already specced in `handoff-bundle-composition`._

### Modified Capabilities

- `handoff-bundle-composition`: the stage-6 preview requirement is strengthened from "a preview component renders the composed bundle" to "the own-branch journey composes, previews, and runs the bundle in-app": the renderer SHALL obtain the bundle via `review.handoff.compose`, SHALL render it with the same preview view-model, SHALL pass the exact previewed bundle to `review.handoff.run`, and SHALL surface the run outcome (including refusal) truthfully.

## Impact

- `packages/ui/src/app.tsx` — own-branch destination surface: handoff state (composed bundle, run status), compose-on-entry to the handoff paper, mount `HandoffPaper`, run action, outcome rendering.
- `packages/ui/src/components/handoff-paper.tsx` — gains the run affordance/outcome props (presentational only; stays `@rennet/types`-importing).
- `packages/ui/src/canvas/destination.ts` / `destination-frame.tsx` — expose the handoff path within the own-branch destination (whatever minimal affordance fits the existing DestinationFrame pattern).
- `apps/desktop` — no dispatch changes expected; renderer↔main contract is the existing protocol commands.
- Docs — product-and-vision "what is live", delivery-order, agent-handoff: the "renderer trigger missing" seam closes; update in the same change.
- Out of scope: post-run delta narration and traceMap consumption (#73); watch-the-agent-work progress narration (#71) beyond a plain pending state.
