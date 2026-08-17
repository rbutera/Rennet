# Command registry v1: conflicts, overrides, menu bar

## Why

Issue #44's palette shipped long ago: `buildCommands` in `packages/ui/src/command/commands.ts` is the one registry (named commands, declared `mod+`-style keybindings as data, context gating standing in for `when` clauses), the ⌘K palette renders and runs it, and labels are platform-aware via `formatKeybinding` (PR #332). What the issue still owes — the live remainder named by delivery-order wave 9 — is exactly three things: nothing detects or discloses a chord collision; a user cannot remap a chord at all, let alone have it survive restart (issue acceptance: "a user JSON override remaps a chord and survives restart"); and the desktop app ships **no menu bar** (`window.removeMenu()` at `apps/desktop/src/main/index.ts:1471`) instead of one "rendered from the same source" as the palette. Key dispatch is also still hardcoded at two sites (`app.tsx` for the `mod+` chords, `workspace.tsx` for the canvas keys), so even a persisted override would change labels without changing behaviour — a lie in the UI.

## What Changes

- **A static command catalogue behind `buildCommands`**: the stable command definitions (id, title, group, default keybinding) become one exported table that `buildCommands` assembles from, so the palette, the settings remap surface, and the menu all read the identical data. `palette.toggle` (⌘K) joins the registry — today it is the one chord that exists nowhere in it. Dynamic entries (`recent.*`, `lens.*`) keep being generated per context, exactly as now.
- **Persistent user keybinding overrides**: an additive-optional `keybindings` field on the shipped `GlobalConfig` (`~/.rennet/config.json`) mapping command id → chord (or explicit unbound). One new bridge command `settings.setKeybinding` writes it through the same malformed-refusing global write path `settings.setAppearance` uses; `settings.get` returns the map additively. Overrides are **applied at dispatch**: the two hardcoded keydown sites route through a registry matcher over effective (default + override) bindings, so a remapped chord actually runs the command and the old chord actually stops.
- **Conflict detection, surfaced as plain disclosure**: a pure function reports every chord claimed by more than one command over effective bindings. The palette marks both colliding rows; the settings Keyboard section names the collision on both rows. Setting a conflicting chord is *accepted and persisted* — the collision is shown and the user picks, never a blocking wizard or a refused write (Rule Zero).
- **A settings Keyboard section**: the catalogue's remappable commands, each showing its effective chord with set / unbind / reset-to-default as plain writes.
- **The application menu, built from the registry**: the renderer projects the same catalogue + live context into a serializable menu template (label, accelerator from the same `mod+` tokens, enabled state from what `buildCommands` currently offers) and sends it to MAIN, which sets `Menu.setApplicationMenu` and routes clicks back as command ids the renderer runs through the same `run` handlers. `window.removeMenu()` goes away. Platform text-editing plumbing (Edit-menu roles, the macOS app menu) is standard Electron roles, not commands.
- **Deliberately not built** (no live consumer): cmdk/tinykeys adoption (the shipped ~380-line registry + palette already does their job; swapping working code for the ratified-but-never-adopted picks is churn, not product), key *sequences* (no command declares one), new command categories, macros, per-repo keybinding layers.

## Capabilities

### New Capabilities

- `command-registry`: the single command registry as the source for palette, keyboard dispatch, settings remap surface, and application menu — including persistent user overrides and honest conflict disclosure.

### Modified Capabilities

- `windows-native-runtime`: shortcut matching now requires the platform-primary modifier instead of treating Meta and Control as interchangeable on every platform.

## Impact

- `packages/ui/src/command/commands.ts`: definitions table extracted (output of `buildCommands` unchanged); pure helpers for override application, chord matching, conflict detection, menu projection.
- `packages/ui/src/components/command-palette.tsx`: conflict marker on colliding rows.
- `packages/ui/src/app.tsx` + `packages/ui/src/components/workspace.tsx`: keydown sites match through the registry (effective bindings) instead of hardcoded chords; overrides fetched with settings and threaded to both sites and to `buildCommands`.
- `packages/ui/src/components/settings-screen.tsx`: Keyboard section (rows, chord recorder, set/unbind/reset, collision notes).
- `packages/protocol/src/index.ts`: `globalConfigSchema` gains optional `keybindings` (additive; old configs parse unchanged, no migration); `settings.get` output gains the map; new `settings.setKeybinding` command.
- `apps/desktop/src/main/settings.ts` + `dispatch.ts`: `setKeybinding` mirroring `setAppearance` (same malformed-config refusal); new `menu.update` handler building `Menu.setApplicationMenu` from the renderer's template, `menu:run` events back.
- `apps/desktop/src/main/index.ts`: `window.removeMenu()` removed; preload exposes the menu channel.
- Docs, same change: `docs/src/content/docs/developing/reference/delivery-order.md` wave-9 entry; `docs/src/content/docs/using/guide/getting-started.md` "Move quickly with the keyboard" (remapping, the menu bar, conflicts).
