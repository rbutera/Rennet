# Context packet — C06 diff-view

Read `openspec/BUILD-LOOP.md` first. Plan row: C6.

## Objective

The raw-diff surface per INVENTORY §4 (28 claims): Map·Diff pill in the top bar, GitHub Files-changed shape, viewed-tracking, filename deep-links (`?view=diff&file=`), line comments through the C4 machinery (same object as board comments). **Port under review** — the spike's diff view is one of its cleanest files; rewrite only the fixture seam (patchset projection via `useCommand`) and comment wiring (store slice, not the dead provider). Leaf components lose their `next/navigation` imports (fence rule 3).

## Out of scope

Board (C5), staging/exits (C8).

## Blocked by

C4. Live patchset via B3 shapes; `MemoryBridge` until then.

## Sources

- Inventory §4, tagged `[ws:C6]` at kickoff · prototype decision: https://github.com/rbutera/rennet/issues/475
- Client asset §5 diff row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Fence addendum: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/diff-view.tsx`, `lib/diff-data.ts` (fixture — becomes a bridge)

## Verification

- `pnpm check` green. E2E: open diff via the pill and via a `?view=diff&file=` deep link cold; mark files viewed; leave a line comment and find the same object from the board side.

## Completion sigil

`<promise>C06-COMPLETE</promise>`
