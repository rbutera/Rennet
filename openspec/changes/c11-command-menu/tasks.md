# Tasks — c11-command-menu (C11, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: INVENTORY §9 (13 `[ws:C11]` claims) + §14 items 1/5/6 (`spikes/board-prototype/INVENTORY.md`), the #477 decision (board/diff content search out), the #465 registry (`packages/protocol/src/commands/index.ts` — the three-reader table), #492/#476 keybinding debts, client asset §5 command-menu row (#489 comment 5431046569), autopsy S7 + fence (#489 comment 5431046732), spike reference read-only (`spikes/board-prototype/components/command-menu.tsx`, `spikes/board-prototype/lib/settings-data.ts`). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

**Session-start bearing:** confirm the base state before cluster 1 — (a) `routes/app.tsx` still binds NO `keydown` (keyboard dispatch is dark, C3 reconciliation 4b); (b) `packages/app-ui/src/store/ui.ts` has `commandMenuOpen`/`setCommandMenuOpen` but NO `commandMenuMode` (reconciliation 1); (c) `packages/protocol/src/commands/index.ts` still initializes every row `commandMenu: false` (reconciliation 2) — if B10 landed and flipped flags, the registry channel renders those rows live instead of the fixture; (d) `command/commands.ts` still exports `effectiveKeybinding`/`matchKeybinding`/`formatKeybinding`/`KeybindingOverrides` (C3 kept them); (e) no `shell/command-menu*` / `shell/key-owner*` file exists yet.

## 1. The global key owner + Escape priority stack (autopsy S7)

- [x] 1.1 `packages/app-ui/src/shell/key-owner.tsx`: ONE window-level `keydown` listener, mounted once by the frame (`routes/layout.tsx`). A priority-stack API — `useKeyLayer({ priority, onKey })` (or equivalent) — where overlays register and the highest live layer gets first refusal on a key. No component mounts its own global `keydown` for app-level keys.
- [x] 1.2 Escape resolves top-down through the stack: the frontmost `ui.openDialogs` entry consumes Escape, else `ui.commandMenuOpen` (close the menu), else the topmost registered layer, else no-op — deterministic, single owner. `ui.openDialogs` (already a stack) and `commandMenuOpen` are the built-in top layers; `useKeyLayer` registers the rest.
- [x] 1.3 Migrate the app-level Escape consumers that exist in `app-ui` today onto the layer API (the interim takeover surfaces that hand-roll Escape — e.g. `settings-screen`, `context-map-view`, `front-door` if any bind window Escape), and record which the sweep found. Do NOT rip out a focused-editor's local Escape (C4's `line-comment-editor`/`selection-toolbar`) — those adopt the API later without forced churn; note them as future adopters. Cluster gate green. Commit.
- [x] 1.4 DOM tests: dialog-open + menu-open ⇒ Escape closes the dialog first, a second Escape closes the menu (proves the ordering); a registered layer receives a non-Escape key only when it is the top live layer; unmounting a layer restores the layer beneath. Commit.

## 2. The ⌘P/⌘K command-menu shell (INVENTORY §9 structure)

- [x] 2.1 `packages/app-ui/src/store/ui.ts` (reconciliation 1): add `commandMenuMode: "search" | "command"` (default `"search"`); `setCommandMenuOpen(open, mode?)` sets the mode (omitted ⇒ unchanged/`"search"`); add `setCommandMenuMode`. Every existing caller stays valid. Update `store/ui` tests.
- [x] 2.2 `packages/app-ui/src/shell/command-menu.tsx`: a `@rennet/ui` `Command` dialog controlled by `ui.commandMenuOpen`/`commandMenuMode` — cmdk fuzzy filter, ↑/↓ navigation, Enter runs, Escape closes **through the key owner** (no private Escape listener). Every entry shows its group name beside its title (§9); an empty result renders "No commands match your search." (§9). `⌘P` opens search-first, `⌘K` command-first (the mode selects the default view; the dialog is one component).
- [x] 2.3 Mount the menu once in the frame (`routes/layout.tsx` or `routes/app.tsx`), outside the outlet, so the sidebar Search row and rail button (which already set `ui.commandMenuOpen`, C3) drive one controlled instance. Confirm the C3 affordances now open a real surface.
- [x] 2.4 DOM tests over `MemoryBridge`-backed `useRennetStore`: opening via `commandMenuOpen`; fuzzy filter narrows; Enter runs the highlighted entry and closes; the empty state renders; group labels show beside titles; ⌘P vs ⌘K default view differs. Cluster gate green. Commit.

## 3. Menu entries — projections for navigation, the registry for commands

- [x] 3.1 Session entries: sourced from C3's `shell/sidebar-data.ts` projection (the SAME query the tree reads — no second source). Title as the value, project + host as extra keywords, **archived excluded** (§9); running one opens the chat (`setChatOpen(true)`) and routes to the session via `routes/url.ts`/`routes/slug.ts` builders (§9). MemoryBridge-stubbed until B9, live when B9 lands — the seam is the one swap point.
- [x] 3.2 Project entries: per project (`projects.list`, real today) a "<project> — Context Map" entry and a "New Chat in <project>" entry (§9), routed through `routes/url.ts`.
- [x] 3.3 Settings-page entries: Environments, Appearance, Keyboard Shortcuts, Projects (§9), each routing to its `/settings/*` path.
- [x] 3.4 Action entries: Add Project and Add Environment (§9) → `uiActions.openDialog("add-project" | "add-environment")` (matching C3's sidebar; the dialog internals are C12).
- [x] 3.5 Registry-command entries (proposal "registry commands", R4): read `commands` from `@rennet/protocol`, filter `exposure.commandMenu === true`, and render each surviving row with a label **derived from the command id** (R4). Today this yields zero rows (reconciliation 2) — the channel renders nothing, honestly. Unit-test the reader + id→label mapping against a fixture registry object with one `commandMenu: true` row (proves a flipped row surfaces the instant B10 flips it). Selecting a registry entry dispatches — that execution is cluster 6.
- [x] 3.6 Board/diff **content** search is OUT (#477): a test/guard asserting the entry set is sourced only from projections + the registry, never from board/diff content. Cluster gate green. Commit.

## 4. Wire the six keybindings through the ONE key owner (§14 item 1)

- [x] 4.1 Define the six-bind action catalogue (spike `settings-data.ts`): `search`→`⌘P` (open menu, search mode), `commands`→`⌘K` (open menu, command mode), `new-chat`→`⌘N` (`openDialog("new-chat")`), `toggle-sidebar`→`⌘B` (`toggleSidebar`), `toggle-chat`→`⌘J` (toggle `chatOpen` via `setChatOpen`), `settings`→`⌘,` (route `/settings`). Reuse `command/commands.ts`'s `effectiveKeybinding`/`matchKeybinding`/`formatKeybinding`/`KeybindingOverrides` (reconciliation 5) — do not duplicate the helpers.
- [x] 4.2 The key owner matches each keydown through the **effective** binding (catalogue default overlaid by the user's override) and runs the action. Re-home `⌘P`: delete the spike-style ad-hoc `⌘P` listener path so no chord is bound twice; all six now fire from the one owner.
- [x] 4.3 Kill raw `⌘R` (R69, registry half): `⌘R` is in no catalogue and the key owner never binds it (the reload chord stays the browser/native default); the Keyboard Shortcuts list advertises no reload row. (The spec-header control deletion is C5, reconciliation 4.) A test asserts `⌘R` is not intercepted and no shortcuts row references reload.
- [x] 4.4 DOM tests: each of the six chords fires its action (menu open in the right mode; sidebar/chat toggle; dialog open; settings route); `⌘R` passes through. Cluster gate green. Commit.

## 5. Keybind remapping (R70/#492) — the Keyboard Shortcuts page's "Change"

- [x] 5.1 The shortcuts settings page per-row "Change" (in `components/settings-screen.tsx`'s keybindings surface): a capture mode that reads the next chord and sets it as the row's override. Format the captured chord with `formatKeybinding`.
- [x] 5.2 Conflict disclosure: when the captured chord already belongs to another row, surface it **inline** (a visible conflict note) and still accept/persist it — disclosed, never blocked (Rule Zero, mirroring `settings.setKeybinding`'s own "conflicting chord accepted" ruling).
- [x] 5.3 Persist through the landed `settings.setKeybinding` command (reconciliation 3) — `settings-screen.tsx` already round-trips `KeybindingOverrides`; wire the capture result into that path. Do NOT invent a `client-settings.json` file (flag the packet/spike naming gap in the report). Overrides load on boot via `settings.get`, so the key owner reads the remapped effective binding after a reload.
- [x] 5.4 DOM tests: capture a chord for a row → the override persists (asserted through the `settings.setKeybinding` mutation over `MemoryBridge`) → a fresh mount reads it as the effective binding and the key owner fires the action on the NEW chord; a conflicting capture shows the inline note and still persists. Cluster gate green. Commit.

## 6. Gated: live wiring (deferred until B10) — registry-command execution

- [x] 6.1 Selecting a registry-command entry (cluster 3.5) dispatches the command through the bridge (`useMutation`/`useCommand`). **Built + tested now over `MemoryBridge`** — a handler for a fixture `commandMenu: true` command; selecting the entry invokes it and the menu closes. The DEFERRED half (labelled): B10 flips the real `exposure.commandMenu` flags and binds live daemon dispatch, at which point the real rows populate and execute with no further C11 change. Never a hollow pass — the dispatch path, entry mapping, and execution-on-select are real and proven here; only the live registry rows wait on B10. Cluster gate green. Commit.

## 7. Barrels, dead-code sweep, docs

- [x] 7.1 `packages/app-ui/src/shell/index.ts` (or the frame's barrel) exports the command menu + key owner API (`useKeyLayer`); `app-ui/src/index.ts` re-exports as the shell surface already is. No public export of internal catalogues that should stay module-private.
- [x] 7.2 Confirm nothing in `packages/app-ui/src` imports from `spikes/` (`grep -rn "from \"@/spikes\|spikes/board-prototype" packages/app-ui/src` returns empty — run and record).
- [x] 7.3 Grep `docs/` (excl. `docs/dist`) for pages that describe the command menu / keyboard dispatch / palette as unbuilt or "dark" (C3's reconciliation 4b left it so), or that list keybindings; update any page this change makes wrong (the command menu now exists; the six binds fire; remapping works), or record the grep as a no-op. Definition of done.
- [x] 7.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses — confirm zero new packages, not assume — lint, typecheck, test, build). Commit.

## 8. Verification (packet)

- [x] 8.1 `pnpm check` green.
- [x] 8.2 Every-keybind E2E: a `MemoryBridge`-backed mount where each of the six chords is dispatched and its action is asserted (menu opens in the correct mode; sidebar toggles; chat toggles; new-chat dialog opens; settings route navigates) — all six through the one key owner.
- [x] 8.3 Remap-and-reload E2E: remap one row via the shortcuts page, persist through `settings.setKeybinding` (`MemoryBridge`), remount fresh, and assert the action fires on the NEW chord and not the old one.
- [x] 8.4 ⌘K-executes-a-registry-command E2E: a `MemoryBridge` handler for a `commandMenu: true` fixture command; `⌘K` → select it → the handler runs end-to-end (proves the registry-command channel; live rows land with B10, reconciliation 6).
- [x] 8.5 Esc-priority E2E with a dialog + the menu both open: Escape closes the dialog first, a second Escape closes the menu. **Positive control shown once**: drop the priority-stack ordering (make Escape close the menu regardless), watch this test fail, revert.
- [x] 8.6 INVENTORY §9 sweep: the 13 `[ws:C11]` claims spot-checked against the built menu; conscious divergences recorded (notably: registry-command entries render zero until B10 flips flags — reconciliation 2, the honest empty state, not a missing feature).
- [x] 8.7 `BUILD-STATUS.json` left for the track-c manager to land (implementers do not touch it); sigil `<promise>C11-COMPLETE</promise>` emitted in the completion report.
