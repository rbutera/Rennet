# B10 — Commands and settings: two registry-driven rebuilds (#489)

## Why

Two subsystems still carry their behavior in hand-maintained lists instead of reading the one #465 registry (`packages/protocol/src/commands`, landed in B3). The packet (`context.md`) is the scope authority; this proposal derives nothing beyond it.

- **Dispatch (#465).** `packages/server/src/dispatch.ts` is a 2,357-line `switch (name)` over ~17 command families. Every new command edits the switch, and nothing proves the switch and the registry agree. The switch dies: `server/dispatch/` becomes a `Map<commandId, handler>` bound from `protocol/commands`, one file per family.
- **Agent tools (#465).** The orchestrator's `app_*` in-process SDK tools are not registry-driven — the whiteboard five are HTTP MCP tools (`WhiteboardClient`, #455-locked names) and there is no in-process `app_*` surface generated from `exposure.agent`. B10 grows that surface by iterating the registry, whiteboard five untouched.
- **Settings (#476).** Global config is one `~/.rennet/config.json` blob mixing viewer preferences with the host's global ladder rung. It splits into `client-settings.json` (viewer prefs, outside the ladder) + `daemon-settings.json` (the global rung on its host), with a mechanical v1 migration. "Runs on" stops being a stored setting and becomes a displayed detected fact.

Out of scope (packet): Settings UI (C10), command-menu UI (C11), sidebar (C3) — the three *other* readers of the same registry. B10 owns only the engine-side registry consumers.

## What Changes

### Dispatch — `Map<commandId, handler>`, one file per family (#465)

- `server/dispatch/` becomes a directory: a `Map<commandId, handler>` bound from `protocol/commands`, one file per command family (`app`, `attention`, `device`, `flagged`, `fs`, `github`, `harness`, `noise`, `openspec`, `pairing`, `patchset`, `project`, `projects`, `publish`, `repository`, `review`, `settings`). The 2,357-line `dispatch.ts` switch is deleted. The registry is the enumeration authority: the map serves **every** command id the old switch did — the two sets diff empty (the verification proof).
- Handler signatures and the surrounding dependency-injection shape (`createDispatch({...})` deps in `create-server.ts`) are preserved; this is a re-seating of existing handler bodies into per-family modules keyed by id, not a rewrite of what each handler does.

### Agent tools — registry-driven `app_*` in-process SDK tools (#465)

- The orchestrator turn grows `app_*` in-process SDK tools by iterating the registry for rows where `exposure.agent` is true (no MCP transport — in-process SDK tools). The whiteboard five stay MCP with their #455-locked names untouched.
- v1 agent set (#465): **add project, list projects, open target + start review, navigate (#480 URL grammar + optional element id), settings read/write** — dispatchable now; **list sessions, open session** — session-scoped, gated on B9 (see Blocked-by). Explicitly OUT of v1: search, pair remote, remove project (their `exposure.agent` stays false).
- `exposure.agent` on the registry is the only per-row datum that decides tool exposure; adding a tool is flipping a row into `AGENT_EXPOSED`, not editing an orchestrator list.
- Rule Zero: the exits are chat-reachable, discipline is prompt-level, and every act is receipt-is-undo. **No mechanical withhold, no consent gate, no capability denial.** A tool that acts is the product.

### Settings — split, migrate, demote (#476)

- The config ladder is **unchanged** in resolution semantics (per-repo `.rennet/` over host-global, pin/reset as today).
- Global config splits: `client-settings.json` holds viewer preferences (appearance, keybindings — the scheme lives here), **outside** the ladder; `daemon-settings.json` holds the global rung as it exists **on its host**. The settings surface lists **every paired host's** `daemon-settings` section, not just the local one.
- `config.json` v1 migrates **mechanically and losslessly** into the two split files on first read; the migration is one-way and deterministic.
- Settings ops join the `app_*` tool surface (they are already in `AGENT_EXPOSED`): UI-originated settings acts do not narrate; conversational (agent-turn) ones do.
- **"Runs on" is demoted** from a stored/selectable setting to a displayed detected fact — Rennet shows where a harness runs; it is not a knob the ladder holds.

## Blocked by (packet)

- **B3** — landed. The `protocol/commands` registry this whole change binds from exists on main.
- **B9** — **NOT landed.** The session-scoped agent tools (**list sessions, open session**) need B9's `session.*` projection commands, which do not exist on `packages/protocol/src/commands/index.ts` today (verify at session start). Every session-scoped-command task is isolated in the FINAL cluster (cluster 6), explicitly gated on B9; everything else is dispatchable ahead of it. When B9 lands, cluster 6 is the only work that unblocks — it flips the `session.*` rows into `AGENT_EXPOSED` and binds their tools.

## Packet-contradicts-reality (recorded, not resolved)

The packet names `adapters/orchestrator-turn.ts` as the file that grows the `app_*` tools. **No such file exists.** The agentic-port / `mcpServers` wiring lives in `packages/server/src/create-server.ts` (`agenticPort: (mcpServers) => …`, ~L441) and the harness adapters (`packages/adapters/src/claude-adapter.ts`, `codex-adapter.ts`); the whiteboard MCP is `packages/adapters/src/whiteboard-client.ts`. The implementer selects the real home for the registry-driven `app_*` bridge (server-side, beside dispatch, is the natural seat since it already holds the registry and dispatch map). Reported for the implementing session; not resolved here — the proposer does not re-home code.

## Verification (packet)

- `pnpm check` green (format, architecture, licenses, lint, typecheck, test, build).
- E2E, positive controls that can fail:
  1. Every registry entry with `exposure.agent` is invocable through a **live orchestrator turn**.
  2. A `config.json` v1 fixture migrates **losslessly** to the split `client-settings.json` + `daemon-settings.json` (round-trip proof).
  3. The dispatch map serves every command the old switch did — **enumerate both, diff empty** (a positive control: add a switch-only id, watch the diff fail, revert).

## Review-fix amendments (fold of origin/main + dual review, 11 findings upheld)

Recorded as scope rulings made while resolving the upheld findings; the packet (`context.md`) stays authority.

- **A1 — B7 tracker survives the split (findings 1, and the fold read/write side).** Main's B7 added a `tracker` section to the legacy v1 config. It is a GLOBAL-rung host fact, so it migrates into `daemon-settings.json` (not client): added to `daemonSettingsSchema`, routed in `migrateLegacyGlobalConfig`, written via a new `updateDaemon` dep from `settings.setTrackerValue`, and read by `resolveTrackerConfig` off daemon settings. The round-trip test now covers the full current-main v1 shape.
- **A2 — onReviewOpened re-seated (finding 2).** The deleted monolith `dispatch.ts` carried main's B07 `deps.onReviewOpened?.(review)` calls at `review.capture` / `review.openPr`. Re-seated into `dispatch/review.ts` + the `DispatchDeps` interface in `dispatch/runtime.ts`; the composition callback in `create-server.ts` and the dispatch-level tests survived the fold. Conflict resolved by keeping `dispatch.ts` deleted (b10's refactor) and preserving main's behaviour in the new structure.
- **A3 — execution locus is detection-only (finding 3).** Dropped the `repo` rung from `LOCUS_SETTING`; `resolveLocus` is now detection-only; `create-server` no longer reads a stored `config.locus` on the execution path. Supersedes any implication that a stored locus override still routes execution — it never reaches resolution now, so the surface's "(detected)" and execution can no longer disagree.
- **A4 — version downgrade is fail-safe (finding 6).** The three settings schemas require the supported version literal (`z.literal(1)`); a future v2 doc reads as *malformed* and is refused (no destructive re-stamp). Migration and `update` both refuse rather than down-migrate.
- **A5 — navigate stays UNREGISTERED, deferred to C11 (finding 8 ruling).** The packet's v1 agent set names `navigate` (#480), but the dispatch table's compile-time exhaustiveness guard forces a **host** handler for every registry row. `navigate` is client-locus; a host handler for it is client execution, which is C11 scope. So `navigate` is NOT added to the registry here — it remains unexposed with an explicit code + docs note. This narrows proposal line 23 ("navigate … dispatchable now"): navigate is deferred, not dispatchable in B10. The rest of the add-project flow IS completed — `repository.choose` + `project.discover` are exposed as the prerequisites of `projects.add` (pure flag flips).
- **A6 — no live orchestrator turn yet (finding 7).** Verification proof 1 ("invocable through a live orchestrator turn") cannot hold in B10: the SDK turn that consumes `app_*` tools was torn down in B2 and is rebuilt in B9/B11. `buildAppTools` is a tested pure projection, exported but unwired; the docs now say so. The live-turn E2E belongs to B9/B11.
- **A7 — paired-host enumeration unions the device inventory (finding 9).** The settings surface lists every paired device as a daemon host section, not only hosts a project routes to.

## Completion sigil

`<promise>B10-COMPLETE</promise>`
