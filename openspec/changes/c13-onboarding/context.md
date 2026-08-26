# Context packet — C13 onboarding

Read `openspec/BUILD-LOOP.md` first. Plan row: C13.

## Objective

The coach-mark system per INVENTORY §11 (26 claims) + R55: contextual marks, one at a time, chained per surface, the nine marks (eight + the Start-a-Review mark from #487), skip/replay semantics, voice split per R55, hand-rolled (no tour library). **Port under review with one structural change**: anchoring via refs or a typed registry, not `data-tour` DOM selectors (the selector contract is already broken — duplicate anchor, autopsy S8; fence rule 7). Seen/skip-all persistence in `client-settings.json` via `settings.*` (§13: `localStorage` dies). R55's cap question was parked on #487 — check that ticket before finalizing mark count.

## Out of scope

New marks beyond the ruled set. Settings persistence engine (B10).

## Blocked by

The surfaces it marks (C3, C8, C12 minimum); schedule late.

## Sources

- Inventory §11, tagged `[ws:C13]` at kickoff · R55 on https://github.com/rbutera/rennet/issues/458 · ninth mark + parked cap: https://github.com/rbutera/rennet/issues/487
- Client asset §5 coach row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S8 + fence rule 7: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/coachmark.tsx`

## Verification

- `pnpm check` green. E2E: fresh profile shows the chain in order, skip-all persists across restart, replay from Help works, every anchor resolves (no orphaned marks — the broken duplicate is the regression to test against).

## Completion sigil

`<promise>C13-COMPLETE</promise>`
