# Context packet — B10 commands-and-settings

Read `openspec/BUILD-LOOP.md` first. Plan row: B10.

## Objective

Two registry-driven rebuilds:

- **Dispatch** (#465): `server/dispatch/` becomes a `Map<commandId, handler>` bound from `protocol/commands` (B3), one file per family — the 2,479-line switch in `dispatch.ts` dies. `adapters/orchestrator-turn.ts` grows the `app_*` in-process SDK tools by iterating the registry where `exposure.agent` (no MCP; whiteboard five stay MCP, names untouched). v1 agent set per #465: add project, list projects/sessions, open session, open target + start review, navigate (#480 URL grammar + optional element id), settings read/write. OUT: search, pair remote, remove project. Exits chat-reachable, prompt-level discipline, receipt-is-undo — no mechanical withhold (Rule Zero).
- **Settings** (#476): the ladder unchanged; global config splits into `client-settings.json` (viewer prefs, outside the ladder) + `daemon-settings.json` (the global rung on its host; surface lists every paired host's section); `config.json` v1 migrates mechanically. Settings ops join the tool surface (UI acts don't narrate, conversational ones do). "Runs on" demoted to displayed detected fact.

## Out of scope

Settings UI (C10), command menu UI (C11), sidebar (C3) — they are the other two readers of the same registry.

## Blocked by

B3. B9 for session-scoped commands.

## Sources

- Decisions: https://github.com/rbutera/rennet/issues/465 · https://github.com/rbutera/rennet/issues/476
- Engine asset §2 server/dispatch + adapters: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Existing: `packages/server/src/dispatch.ts` (the switch to kill), `packages/protocol` commandDefinitions
- Docs: `docs/developing/guides/settings-and-setup.md`, `surfacing-and-routing.md`

## Verification

- `pnpm check` green. E2E: every registry entry with `exposure.agent` is invocable through a live orchestrator turn; a `config.json` v1 fixture migrates losslessly to the split files; the dispatch map serves every command the old switch did (enumerate both, diff empty).

## Completion sigil

`<promise>B10-COMPLETE</promise>`
