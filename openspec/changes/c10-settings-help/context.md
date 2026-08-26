# Context packet — C10 settings-help

Read `openspec/BUILD-LOOP.md` first. Plan row: C10.

## Objective

Settings + Help per INVENTORY §8 (92 claims): full-view takeover (chat included, back/Esc out), the pages (Environments with source-control detection + daemon sections per paired host, Agents/review roles with Model Council mappings, Appearance, Keyboard shortcuts, Projects incl. Issue Tracker section, Archived), Help = Documentation / Keyboard shortcuts / Report an issue, Update button-only. **Port page layout, rewrite every value** onto `settings.*` commands + detection projections — the entire `settings-data.ts` fixture dies, but its `{value, layer}` provenance shape is a keep (it is a product feature; B10 serves it). Settings page = route (`/settings/:page?project=`), never shadowed `useState` (autopsy S2 is the named sin). "Runs on" is a displayed detected fact, no override.

## Out of scope

Settings engine + file split (B10). Keybind remapping mechanics (C11).

## Blocked by

C3; B10 for live values (`MemoryBridge` first).

## Sources

- Inventory §8, tagged `[ws:C10]` at kickoff · the decision: https://github.com/rbutera/rennet/issues/476
- Client asset §5 settings row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S2/S5 (`settings-view.tsx` 1,687 lines, 4 screens in one file — a screen is a directory) + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/settings-view.tsx`, `lib/settings-data.ts`
- Docs: `docs/developing/guides/settings-and-setup.md`

## Verification

- `pnpm check` green. E2E: deep-link every settings page cold; change scheme + a keybind and see them persist to `client-settings.json`; provenance chips show detected vs global; Esc returns to the prior surface with chat intact.

## Completion sigil

`<promise>C10-COMPLETE</promise>`
