# Tasks — b10-commands-and-settings (B10, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md`. One cluster per session; the repo compiles and the gate is green after every cluster. **Checkbox per task, one commit per completed task** (BUILD-LOOP discipline). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless a task says the full `pnpm check`.

**Session-start bearing (Blocked-by):** B3 has landed — `packages/protocol/src/commands/index.ts` carries the registry (`commands`, `CommandExposure`, `AGENT_EXPOSED`). B9 has **NOT** landed — grep `session\.` in `index.ts`; if there is still no `session.*` command, clusters 1–5 proceed and **cluster 6 stays blocked**. If B9 has landed by the time you reach it, cluster 6 unblocks with no other change.

**Packet drift (proposal):** the packet names `adapters/orchestrator-turn.ts`; it does not exist. The `app_*` bridge's real home is the implementer's call (server-side beside dispatch is the natural seat) — see proposal "Packet-contradicts-reality". Do not invent that file blindly.

---

## 1. Dispatch — `Map<commandId, handler>`, one file per family (#465)

Kills the 2,357-line `switch (name)` in `packages/server/src/dispatch.ts`. Serves the commands that exist today — **not** B9-gated.

- [x] 1.1 Create `packages/server/src/dispatch/` with one module per command family (`app`, `attention`, `device`, `flagged`, `fs`, `github`, `harness`, `noise`, `openspec`, `pairing`, `patchset`, `project`, `projects`, `publish`, `repository`, `review`, `settings`). Each module exports its family's `{ commandId → handler }` entries. Handler bodies are the existing switch-arm bodies re-seated verbatim; do not change what any handler does.
- [x] 1.2 `packages/server/src/dispatch/index.ts` (or `dispatch.ts` shrunk to the composer): build a `Map<commandId, handler>` bound from `protocol/commands`, assembled from the per-family modules. Preserve the `createDispatch({...})` DI surface and its consumers in `create-server.ts` — same deps in, same dispatch-call shape out.
- [x] 1.3 Delete the old `switch (name)` body. The map is the only router. Wire the map lookup so an unknown/unregistered id fails the same way the switch's default did (no new gate — Rule Zero).
- [x] 1.4 Diff-empty proof (unit): enumerate the map's keys and the registry's `exposure.agent`-independent id set; assert the map serves **every** command id the registry declares (and the pre-refactor switch served). **Positive control shown once**: add a registry id the map omits, watch the assertion fail, revert.
- [x] 1.5 Cluster gate green. Commit.

## 2. Agent tool surface — registry-driven `app_*` in-process SDK tools (#465, non-session)

Grows the orchestrator's `app_*` tools by iterating the registry. Whiteboard five stay MCP, names untouched. Non-session v1 set only — **not** B9-gated.

- [x] 2.1 Build the `app_*` bridge at the implementer-selected home: `packages/server/src/agent-tools.ts` (server-side beside dispatch — it already holds the registry + dispatch map). `buildAppTools(dispatch)` iterates `commands` for rows where `exposure.agent` is true and yields one neutral `AppTool` descriptor each (name `app_<id>` with dots flattened, args schema + label from the row, `run` → `dispatch(id, …)`). No MCP transport. The whiteboard five (`WhiteboardClient`, #455 names) are untouched — they are `WhiteboardClient` methods, not registry ids, so they are structurally absent from the loop.
- [x] 2.2 `AGENT_EXPOSED` (`protocol/commands/index.ts`) already carries the v1 non-session set: `projects.add`, `projects.list`, `review.openPr` + `review.capture`, and the settings ops. **navigate**: the client-locus navigate command **does not exist** in the registry (grep confirmed — the AGENT_EXPOSED comment already records this); left unbound, not stubbed. Confirmed v1-OUT stays `agent:false`: `projects.remove` is not in `AGENT_EXPOSED`; **search** and **pair-remote** have no command id at all, so cannot be exposed.
- [ ] 2.3 Wire into the live orchestrator turn — **BLOCKED-BY-REALITY, not stubbed.** The live orchestrator leg (Claude over the canvasOps@2 MCP server) was **torn down in the B2 board rebuild** (`review-ask-live.ts` `askOrchestrator` returns "unavailable during the Board rebuild"; the `agenticPort` lambda on `create-server.ts` is defined but consumed by no live path; the Claude adapter's option surface carries no in-process-tool field). There is no live turn to wire into, and rebuilding it is a different track's scope — wiring here would mean inventing the torn-down orchestrator (tasks.md forbids). The bridge is exported from `@rennet/server` (`buildAppTools`) so the orchestrator-turn rebuild consumes it with no change here. Revisit when the agentic turn lands.
- [x] 2.4 Test (`agent-tools.test.ts`): each `exposure.agent` row produces exactly one `app_*` tool (registry-iteration proof — the tool set equals the projection of the flag, so a flipped row appears with no edit); names are unique + `app_`-prefixed; `run` dispatches the command id; the whiteboard five are structurally absent (every tool is a registry command). Cluster gate green (rennet-server lint + typecheck + test: 515 tests pass).

## 3. Settings — split global config into two files + mechanical migration (#476)

The ladder resolution is unchanged; only the storage splits. Not B9-gated.

- [x] 3.1 Define `client-settings.json` (viewer prefs — appearance/scheme, keybindings; **outside** the ladder) and `daemon-settings.json` (the global rung as it exists **on its host**) shapes in `protocol` (schemas beside `globalConfigSchema`). Version them.
- [x] 3.2 Split the stores: `packages/adapters/src/file-config-store.ts` (and `packages/server/src/settings.ts` composition) read/write the two files. Viewer prefs go to `client-settings.json`; the host-global rung to `daemon-settings.json`. Ladder resolution semantics (per-repo over global, pin/reset) unchanged — prove with the existing ladder tests still green.
- [x] 3.3 Mechanical v1 migration: on first read of a legacy `config.json` v1, split it losslessly and deterministically into the two files (one-way). Round-trip test over a `config.json` v1 fixture: every field lands in the correct target file, nothing dropped. **Positive control**: remove one migrated field's mapping, watch the round-trip assert fail, revert.
- [x] 3.4 Cluster gate green. Commit.

## 4. Settings tool surface + "Runs on" demotion (#476)

- [x] 4.1 Confirm the settings ops (`settings.get`, `settings.setAppearance`, `settings.setKeybinding`, `settings.setRepoVisibility`, `settings.setRepoLocus`, `settings.resetRepoValue`, `settings.pinRepoValue` — already in `AGENT_EXPOSED`) surface as `app_*` tools through cluster 2's bridge. UI-originated settings acts do not narrate; conversational (agent-turn) ones do — verify the narration boundary holds. (Test asserts every `settings.*` agent-flagged op projects to an `app_*` tool; narration boundary is prompt-level, not a mechanical gate — the bridge exposes them unconditionally, Rule Zero. Note: 4.3 demotes `settings.setRepoLocus`, so the test is written over the live flag set, not a frozen id list.)
- [x] 4.2 The settings surface lists **every paired host's** `daemon-settings` section (not just local) — expose it through the settings composition/projection. (`SettingsView.daemonHosts`: local host first with its readable `daemon.listen` rung, then every distinct non-local `source` the projects route to. A remote/WSL host is LISTED so it is visible, but its rung lives on that host — the client cannot read a remote daemon-settings from here, so `listen` is populated only for local. **Packet-vs-reality**: literal cross-daemon aggregation of remote hosts' full settings needs a remote-settings fetch the board rebuild hasn't landed; the enumeration + local rung is the buildable, honest projection.)
- [x] 4.3 Demote "Runs on": remove it as a stored/selectable ladder value; surface it as a displayed **detected fact** (where the harness runs), not a knob. Update the settings projection/read path accordingly. (Removed `settings.setRepoLocus` cmd + its AGENT_EXPOSED entry + `SetRepoLocusOutcome`; dropped `locus` from `SettingsRepoValueKey` so pin/reset is visibility-only; `SettingsProject.locusOverridden` gone, locus + `detected` provenance computed from `detectLocus`. Composition/dispatch/projection lose `setRepoLocus`/`applyLocus`; app-ui "Runs on" row is read-only. Live git/harness execution in create-server UNTOUCHED — `resolveLocus(detectLocus,config?.locus)` auto-degrades to detected now nothing writes `config.locus`. Docs updated. **Packet-vs-4.1**: 4.1 listed `settings.setRepoLocus` among ops to keep — the demotion removes it; 4.1's test uses the live flag set, no change needed.)
- [x] 4.4 Test: paired-host sections enumerate; "Runs on" is read-only detected, not settable. Cluster gate green. Commit. (Enumeration proof: `settings.test.ts` "daemon host sections" — local-first + every distinct project `source`. Read-only-detected proof: `settings.test.ts` "locus is a detected fact" (locus from `detectLocus`, `detected` provenance) + app-ui dom test "'Runs on' row renders as a read-only detected fact" (no controls, no `setRepoLocus` call) + the type-level removal of `settings.setRepoLocus`/`SettingsRepoValueKey.locus`. Those tests landed in the 4.2/4.3 commits per checkbox-per-task discipline; this commit ticks the box + carries the eslint-suppressions prune the demotion required. Full `pnpm check` green.)

## 5. Docs + verification (definition of done, packet)

- [x] 5.1 Update `docs/developing/guides/settings-and-setup.md`: the two-file split (`client-settings.json` / `daemon-settings.json`), the mechanical `config.json` v1 migration, "Runs on" as a detected fact. Do not narrate the old single-blob history (docs describe current Rennet).
- [x] 5.2 Update `docs/developing/concepts/surfacing-and-routing.md`: the registry is the single source for dispatch, the `app_*` agent tools, and the menu; the dispatch map replaces the switch; `exposure.agent` gates the agent surface. Add a `mermaid` fence if a picture clarifies the three-reader registry flow.
- [ ] 5.3 Full gate `sh -c 'pnpm check'` green (dispatch + settings touch server entries — run the whole gate, not just affected).
- [ ] 5.4 E2E proof 1 (packet): every **non-session** `exposure.agent` entry is invocable through a **live orchestrator turn**. Proof 2: `config.json` v1 fixture migrates losslessly to the split files. Proof 3: dispatch-map-vs-switch enumeration diffs empty (cluster 1.4 control). Evidence shown, never asserted.

---

## 6. Session-scoped agent tools — GATED ON B9 (dispatch last, do not start until B9 has landed)

> **This cluster is blocked on B9** (`session.*` projection commands), which is NOT on main as of this proposal. Everything above is dispatchable ahead of it. Grep `session\.` in `packages/protocol/src/commands/index.ts` at session start: if there is still no `session.*` command, **leave this cluster unchecked with a note** — never a hollow pass (BUILD-LOOP). When B9 lands, this is the only work that unblocks, and it changes nothing above.

- [ ] 6.1 Flip the session-scoped rows into `AGENT_EXPOSED`: **list sessions** and **open session** (bind to B9's `session.*` command ids once they exist). Cluster 2's registry-iterating bridge then emits their `app_*` tools automatically — no orchestrator-list edit.
- [ ] 6.2 Wire "open session" navigation through the #480 URL grammar (open-session as a session-URL navigate) and "list sessions" through B9's session projection. Receipt-is-undo, chat-reachable, no withhold (Rule Zero).
- [ ] 6.3 Extend E2E proof 1 to the session-scoped tools: list sessions and open session are invocable through a live orchestrator turn. Cluster gate + full `pnpm check` green. Commit.
- [ ] 6.4 Completion: every task checked (or 6.x noted-blocked if B9 is still out), verification run, `BUILD-STATUS.json` b10 → `{"status":"done","passes":true}` (or landing agent handles it), emit `<promise>B10-COMPLETE</promise>`.
