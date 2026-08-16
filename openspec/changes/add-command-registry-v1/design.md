## Context

What exists (verified 2026-08-16 against live code):

- `packages/ui/src/command/commands.ts` — the registry: `Command` records with `keybinding` as data (`mod+X` tokens or bare keys), `buildCommands(ctx)` a pure context-gated assembler (the `when`-clause role), `filterCommands`/`fuzzyScore`, `isMacPlatform`/`formatKeybinding` (PR #332).
- `packages/ui/src/components/command-palette.tsx` — the ⌘K overlay: renders `formatKeybinding(command.keybinding)` per row, runs `command.run`.
- `packages/ui/src/app.tsx` ~630–652 — hardcoded window keydown: `mod+K` toggles the palette, `mod+[`/`mod+]` history. The palette toggle is not a registry command.
- `packages/ui/src/components/workspace.tsx` ~894–907 — hardcoded canvas keydown: `[`/`]` rotate, `l`/`h` (+ arrows/Escape) zoom, guarded by `isEditableTarget`.
- `apps/desktop/src/main/index.ts:1471` — `window.removeMenu()`. No application menu exists.
- `packages/protocol/src/index.ts:1495` — `globalConfigSchema` (`version` + optional `appearance`), every field beyond `version` optional by design.
- `packages/adapters/src/file-config-store.ts` — atomic global-config store at `~/.rennet/config.json`; `apps/desktop/src/main/settings.ts:204` `setAppearance` shows the write pattern (`updateGlobal` refuses on malformed).
- No override storage, no conflict detection anywhere (grep-verified).

Issue #44's cmdk/tinykeys picks were never adopted; the shipped custom implementation covers their job. Rule Zero: overrides are plain edits, conflicts are disclosure, the menu is capability.

## Goals / Non-Goals

Goals: one catalogue behind palette/dispatch/settings/menu; persisted overrides effective at dispatch; conflict disclosure; a real application menu.

Non-Goals: cmdk/tinykeys adoption (working code already shipped; swapping it is churn); key sequences (no command declares one); macros or new command categories; per-repo keybinding layers; riding the unshipped settings registry (next decision).

## Decisions

**1. Overrides persist in the shipped `GlobalConfig`, not the pending settings ladder.**
`globalConfigSchema` gains `keybindings: z.record(z.string(), z.string().nullable()).optional()` — command id → chord token, `null` meaning explicitly unbound, key absent meaning default applies. Delivery-order says wave 9 comes "after settings, which owns the override store", but wave 8's `add-settings-v1` is itself unshipped and its proposal explicitly defers the override store to #44 ("#44's palette-override store will later register through the same table; nothing in this change builds it"). Coupling two unshipped changes so each blocks the other is the tighter coupling; the shipped `FileConfigStore` + `updateGlobal` path is live, atomic, malformed-refusing, and *is* the settings ladder's global layer's backing file — when the schema registry lands, it registers a `keybindings` global-layer key over this same field with zero migration. Alternative rejected: waiting for `add-settings-v1` to merge first — an ordering dependency for no behavioural difference.

**2. Wire shape mirrors `setAppearance`.**
`settings.get` output gains optional `keybindings` (the stored map, verbatim — additive, old callers unaffected). One new command `settings.setKeybinding { id, keybinding: string | null | omitted }`: a string sets the override, `null` unbinds, omitted deletes the entry (reset to default). The handler is `updateGlobal` spreading the map, same malformed refusal as `setAppearance`. Alternative rejected: separate set/unbind/reset commands — three IPC entries for one map edit.

**3. The catalogue is an extracted constant table; `buildCommands` output is byte-identical.**
The stable definitions (id, title or title-fn, group, default keybinding) move to an exported `COMMAND_CATALOGUE` const in `commands.ts`; `buildCommands` assembles from it under the exact gating it has today. Existing `commands.test.ts` is the refactor's positive control. Dynamic entries (`recent.*`, `lens.*`) stay generated (no bindings, no menu presence beyond a disabled-less omission — they are palette-only). `palette.toggle` (default `mod+k`) is added to the catalogue with its `run` supplied by app context like every other handler. The settings Keyboard section lists catalogue commands that have a default binding or a stored override — context-independent, so it renders outside the workspace.

**4. Dispatch matches through the registry; two pure helpers.**
`effectiveKeybinding(def, overrides)` overlays the stored map (null ⇒ none); `matchKeybinding(commands, { key, mod })` returns the command whose effective binding matches a normalized chord. `app.tsx`'s window listener replaces its hardcoded `k`/`[`/`]` checks with a match over the built commands (plus `palette.toggle`); `workspace.tsx` receives the overrides map as a prop and matches its bare keys (`l`/`h`) the same way, keeping arrows/Escape as hardcoded synonyms (they are affordances, not registry chords) and keeping the `isEditableTarget` guard. The overrides map is fetched once with the existing `settings.get` call in `app.tsx` and updated in state after each `setKeybinding` outcome.

**5. Conflict detection is one pure function over effective bindings.**
`findConflicts(entries): Map<chord, id[]>` — entries are either the live built commands (palette: a conflict shown only when both commands can actually fire) or the full catalogue + overrides (settings: the user managing bindings sees every collision, including cross-context ones, labelled as such). Disclosure: the palette row's `<kbd>` gains a conflict style + title naming the other command; each settings row names its counterpart inline. Writes are never refused for conflicting — the disclosure is the entire mechanism (Rule Zero).

**6. Menu: renderer projects, MAIN builds, clicks come back as ids.**
A pure `menuTemplate(catalogue, ctx, overrides)` in `commands.ts` returns serializable sections `{ id, label, accelerator?, enabled }` — label from the same title data, accelerator from the effective `mod+` token (MAIN translates `mod+` → `CmdOrCtrl+`; bare-key bindings are displayed but registered with `registerAccelerator: false`, and `mod+` items likewise stay display-only where the renderer already dispatches, so a chord press runs exactly once — a DOM/main test pins single-fire), enabled from whether `buildCommands(ctx)` currently offers the command. Renderer sends it over a new one-way `menu.update` on context/override change (debounced by React's own effect cadence); MAIN wraps it in the standard role scaffolding (macOS app menu, Edit roles for text editing, Window) and calls `Menu.setApplicationMenu`; item click sends `menu:run { id }` back through preload; the renderer looks the id up in its current built list and calls the same `run`. A `menu:run` for a command the context no longer offers is dropped (the disabled state raced the click) — never a throw. `window.removeMenu()` is deleted; Windows/Linux get the in-window menu bar.

## Risks / Trade-offs

- [Double dispatch: menu accelerator + renderer keydown both fire] → accelerators are display-only (`registerAccelerator: false` / no key-equivalent registration on the command items); the renderer stays the single chord dispatcher. A test asserts one run per press.
- [Menu updates on every context flicker] → the template is derived state from values `app.tsx` already holds; an effect posts only when the serialized template changes.
- [A stored chord that parses to nothing (garbage in config.json)] → `normalizeChord` returns null for an unrecognizable token; the command falls back to its default and the settings row shows the stored-but-unusable value honestly. Never a throw.
- [Catalogue refactor silently changing palette output] → existing `commands.test.ts` + `app.command-palette.dom.test.tsx` are the positive control; the refactor task runs them before any new behaviour lands.
- [`add-settings-v1` later wants the override store on the ladder] → the field is already the global layer's file; registering the key is additive in that change, no migration (Decision 1).

## Migration Plan

None: one additive-optional protocol field, additive `settings.get` output, one new command, one new IPC channel. Old configs parse unchanged. Rollback is reverting the change: the old `globalConfigSchema` is non-strict, so a config carrying `keybindings` still parses (the unknown key is stripped on parse, and thus dropped on the next old-build write) — an acceptable loss for a personal preference field.

## Open Questions

None.
