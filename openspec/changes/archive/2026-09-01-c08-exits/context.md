# Context packet — C08 exits

Read `openspec/BUILD-LOOP.md` first. Plan row: C8.

## Objective

The hand-off surfaces per INVENTORY §6 (70 claims): exit FAB + pip (batched `signal` slice — module-global `fab-signal.ts` state does not travel, autopsy S8), asks basket + staging, **Hand off = view toggle** with mode-dependent lanes (teammate PR: post review only; own branch: This round + The pull request), living draft in GitHub's two-strata shape with selection steering + retired ledger, verdict segmented control (proposed-not-derived), preview → direct Post. **Port layout, rewrite everything stateful**: verdict arithmetic, ask claiming, pip counts, retired ledger become selectors over B11's durable projections; string-surgery "rework a span" becomes the real rework command. Receipt-is-undo throughout; posting only on explicit click.

## Out of scope

Round running/report (C9); the composition engine (B11 owns it).

## Blocked by

C4, C5; B11 for live behavior (build on `MemoryBridge` first).

## Sources

- Inventory §6, tagged `[ws:C8]` at kickoff · rulings R29–R36 + amendments on https://github.com/rbutera/rennet/issues/458
- Client asset §5 exits row + risk 5 (asks durable — decided): https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S8 + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/{handoff-view,handoff-action,rounds-lanes,fab-pips}.tsx`

## Verification

- `pnpm check` green. E2E: stage asks from board + diff, watch the pip derive, toggle hand-off in both modes, steer a draft span, retire + restore a block, reload mid-staging — everything survives (B11), preview a post without posting.

## Completion sigil

`<promise>C08-COMPLETE</promise>`
