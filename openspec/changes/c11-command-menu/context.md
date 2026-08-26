# Context packet — C11 command-menu

Read `openspec/BUILD-LOOP.md` first. Plan row: C11.

## Objective

⌘P / ⌘K per INVENTORY §9 (13 claims) + the keybinding debts in §14: one menu, search-first (⌘P) / command-first (⌘K), entries sourced from the `protocol/commands` registry where `exposure.commandMenu` + sessions/settings-pages/scenario navigation from projections — the menu is one of the registry's three readers, R4 labels derive from command ids. **Wire the six advertised-but-unwired keybindings** (§14 item 1 — an advertised bind that does nothing is a UI lie), kill raw ⌘R (R69), and build keybind remapping (R70/#492) persisting to `client-settings.json`. One global key owner with a priority stack replaces the spike's six hand-rolled Escape listeners (autopsy S7). Board/diff content search deliberately out (#477).

## Out of scope

The registry itself (B10). Content search.

## Blocked by

C3; B10 for live command execution.

## Sources

- Inventory §9 + §14 items 1/5/6, tagged `[ws:C11]` at kickoff · the decision: https://github.com/rbutera/rennet/issues/477 · registry: https://github.com/rbutera/rennet/issues/465 · debts: https://github.com/rbutera/rennet/issues/492
- Client asset §5 command-menu row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S7 + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/command-menu.tsx`

## Verification

- `pnpm check` green. E2E: every advertised keybind fires; remap one and it fires on the new chord after reload; ⌘K executes a registry command end-to-end; Esc priority resolves correctly with a dialog + menu open.

## Completion sigil

`<promise>C11-COMPLETE</promise>`
