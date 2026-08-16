# Tasks

Red-first throughout: each behaviour lands as a failing test before its implementation, and every refactor names its positive control.

## 1. Catalogue extraction (behaviour-preserving refactor)

- [ ] 1.1 Run `packages/ui/src/command/commands.test.ts` + `app.command-palette.dom.test.tsx` green (the positive control for this whole section).
- [ ] 1.2 Extract the stable definitions from `buildCommands` into an exported `COMMAND_CATALOGUE` const (id, title/title-fn, group, default keybinding); `buildCommands` assembles from it. Re-run 1.1 — output must be unchanged.
- [ ] 1.3 Red: catalogue test — the catalogue contains `palette.toggle` (default `mod+k`), `nav.back` (`mod+[`), `nav.forward` (`mod+]`), `zoom.in` (`l`), `zoom.out` (`h`), each id unique. Green: add `palette.toggle` to the catalogue; its `run` is supplied by app context like every other handler.

## 2. Persisted overrides (protocol + main)

- [ ] 2.1 Red: protocol test — `globalConfigSchema` parses `{ version, keybindings: { "nav.back": "mod+e", "zoom.in": null } }`; a config without the field still parses (additive control). Green: add the optional `keybindings` record.
- [ ] 2.2 Red: `apps/desktop/src/main/settings.test.ts` — `setKeybinding` with a string persists the entry (re-read from the store proves survival, the restart criterion); `null` persists an explicit unbind; omitted keybinding deletes the entry; a malformed global config refuses the write exactly as `setAppearance` does. Green: `settings.setKeybinding` command in `packages/protocol` + composition handler over `updateGlobal` + dispatch wiring.
- [ ] 2.3 Red: `settings.get` output includes the stored `keybindings` map; absent field yields no key (additive control: existing `settings.get` tests stay green). Green: thread the map through `SettingsView`.

## 3. Overrides applied at dispatch

- [ ] 3.1 Red: unit tests for `effectiveKeybinding` (default / overridden / unbound / garbage token → default with the stored value still reportable) and `matchKeybinding` (mod-chord, bare key, no match). Green: implement both, plus `normalizeChord` (null on unrecognizable).
- [ ] 3.2 Red: `app.tsx` DOM test — with `keybindings: { "nav.forward": "mod+e" }` from the settings bridge, pressing mod+e navigates forward and pressing mod+] does not; `palette.toggle` remapped moves ⌘K. Green: replace the hardcoded window-keydown chord checks with a registry match over the built commands; fetch overrides via the existing `settings.get` call.
- [ ] 3.3 Red: workspace DOM test — with `zoom.in` overridden to `j`, pressing `j` zooms in and `l` does not; arrows/Escape synonyms and the `isEditableTarget` guard still hold (control: existing workspace key tests stay green). Green: pass the overrides map into `workspace.tsx` and match `l`/`h` through the registry.

## 4. Conflict detection + settings Keyboard section

- [ ] 4.1 Red: `findConflicts` unit tests — two commands on one effective chord are reported together; distinct chords report nothing; an override *creating* a collision is detected. Green: implement.
- [ ] 4.2 Red: palette DOM test — two live commands sharing a chord both render the chord with a collision disclosure naming the other; non-conflicting rows carry none. Green: conflict marker in `command-palette.tsx`.
- [ ] 4.3 Red: settings-screen DOM test — the Keyboard section lists catalogue commands with bindings; set/unbind/reset each call `settings.setKeybinding` with the right payload; two colliding rows both disclose the collision **and the conflicting write is accepted and persisted** (the Rule Zero control: no confirmation element exists, the bridge write fires unconditionally). Green: the Keyboard section (rows, chord recorder capturing the next keydown, plain set/unbind/reset controls).

## 5. Application menu from the registry

- [ ] 5.1 Red: `menuTemplate` unit tests — labels/accelerators come from the catalogue + overrides (`mod+` token preserved for MAIN to translate), a command absent from `buildCommands(ctx)` projects `enabled: false` not absence, dynamic `recent.*`/`lens.*` entries are excluded. Green: implement in `commands.ts`.
- [ ] 5.2 Red: main-process test (dispatch.test style) — a `menu.update` payload builds an Electron template wrapped in the role scaffolding (macOS app menu, Edit roles, Window), `mod+` → `CmdOrCtrl+`, command items display-only accelerators (`registerAccelerator: false`), and simulating an item click emits `menu:run { id }` to the renderer. Green: `menu.update` handler + `Menu.setApplicationMenu`; delete `window.removeMenu()`; preload channel.
- [ ] 5.3 Red: `app.tsx` DOM test — a `menu:run` event runs the same handler the palette row runs, exactly once; a `menu:run` for a command the context no longer offers is dropped without a throw; a context change and an override change each repost the template (and only when it changed). Green: renderer wiring (template effect + `menu:run` listener).

## 6. Docs (same change — the definition of done)

- [ ] 6.1 `docs/src/content/docs/developing/reference/delivery-order.md`: rewrite the wave-9 entry to the delivered scope (conflict disclosure, persisted overrides at dispatch, registry-built menu; override store on shipped `GlobalConfig` with the ladder adopting it later).
- [ ] 6.2 `docs/src/content/docs/using/guide/getting-started.md` "Move quickly with the keyboard": remapping from Settings → Keyboard, unbind/reset, how collisions are shown, and that the menu bar mirrors the palette.

## 7. Gate

- [ ] 7.1 `pnpm check` green (includes the positive controls from 1.1); push only after.
