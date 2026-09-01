# Context packet — C02 ui-kit-additions

Read `openspec/BUILD-LOOP.md` first. Plan row: C2. Small change; may run beside C1.

## Objective

Six generic primitives into `packages/ui` (zero Rennet vocabulary, zero protocol types): `context-menu`, `collapse`, `resizable`, `toggle-group`, `kbd`, `progress`. Port `spikes/board-prototype/components/collapse.tsx` (the 35-line grid-rows `0fr→1fr` + `inert` disclosure — autopsy keep-list) and `resize-handle.tsx` under review through the fence; source the rest from the shadcn/Base UI registry per the port arc (Base UI, not Radix). Theme tokens only — any `text-[Npx]` bracket the port surfaces is a gap to fill in `packages/theme`, not a bracket to keep.

## Out of scope

Rennet composites (every other C-change). Replacing existing `ui` components.

## Blocked by

Nothing.

## Sources

- Client asset §1 ui layer: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Fence addendum (all 11 rules): https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Autopsy S6 (five hand-rolled segmented controls — `toggle-group` exists to kill them; enforce kit-not-hand-rolled with lint)
- Kit conventions: `packages/ui/src/*`, `packages/theme`, licence blocklist (memory: shadcn port arc)

## Verification

- `pnpm check` green (licences included). Each primitive has a story/test mount; `collapse` keeps content mounted and tab-order inert when closed.

## Completion sigil

`<promise>C02-COMPLETE</promise>`
