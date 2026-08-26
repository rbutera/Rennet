# Context packet — C09 rounds

Read `openspec/BUILD-LOOP.md` first. Plan row: C9.

## Objective

The rounds experience per INVENTORY §7 (40 claims): dispatch → live run takeover (`/s/:slug/run`, deep-linkable cold), round report as the greeting (first-class board — reuses the C5 registry), progressive reveal (report readable while drafters regenerate beneath; **View the New Boards** appears at composition, never disabled), rounds ledger beside Map·Diff (present exactly when a round completed; every report + frozen generation + round diff reachable), post-round delta-mark behavior. **Rewrite** — every spike timeline is a simulated `setTimeout` (§13); real progress rides `onProgress` via `useCommandStream`. The run route's effect-navigation race (autopsy S9) is the named anti-pattern: model run state as a machine, navigate from transitions.

## Out of scope

The round engine (B8/B9/B11). Exits lanes (C8).

## Blocked by

C5, C8; B9 for live rounds.

## Sources

- Inventory §7, tagged `[ws:C9]` at kickoff · the decision: https://github.com/rbutera/rennet/issues/486 (R57/R58) · R34 loop on https://github.com/rbutera/rennet/issues/458
- Client asset §5 rounds row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S9 + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/{run-view,round-report}.tsx`

## Verification

- `pnpm check` green. E2E: run a real round — live progress, greeting on return, reveal button at composition, ledger row appears, prior generation reachable; cold deep-link to `/s/:slug/run` mid-round reattaches without double-dispatch.

## Completion sigil

`<promise>C09-COMPLETE</promise>`
