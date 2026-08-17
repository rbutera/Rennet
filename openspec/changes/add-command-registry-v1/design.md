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
The stable definitions (id, title or title-fn, group, default keybinding) move to an exported `COMMAND_CATALOGUE` const in `commands.ts`; `buildCommands` assembles from it under the exact gating it has today. The full id/title/group/keybinding matrix is the cross-context positive control. Dynamic entries (`recent.*`, `lens.*`) stay generated (no bindings, no menu presence beyond a disabled-less omission — they are palette-only). `palette.toggle` (default `mod+k`) is added to the catalogue and materialized through the same catalogue helper as every other command. The settings Keyboard section lists every catalogue command, including commands without a default, plus stored unknown-id overrides with Reset so stale entries remain reclaimable.

**4. Dispatch matches through the registry; two pure helpers.**
`effectiveKeybinding(def, overrides)` overlays the stored map (null ⇒ none) and falls back to the default when a stored token fails the v1 grammar; `matchKeybinding(commands, chord)` returns the first matching command. `chordFromEvent` records the platform-primary modifier only (Meta on macOS, Control elsewhere) and marks Shift, Alt, or a non-primary modifier unsupported. `app.tsx` matches every chord, with bare keys guarded in editing controls. `workspace.tsx` matches the full catalogue first: another command's effective binding wins over a bracket/arrow/Escape alias, an explicit zoom unbind disables that zoom command's aliases, and a locally handled zoom stops propagation before the app dispatcher. Settings publishes every successful returned override map to app state immediately; its recorder stops propagation and refuses unsupported combinations inline rather than discarding modifiers.

**5. Conflict detection is one pure function over effective bindings.**
`findConflicts(entries): Map<chord, id[]>` inspects the full catalogue plus dynamic live commands for the palette, so a visible command also sees a collision with catalogue-only `palette.toggle`; Settings inspects the full catalogue. Disclosure: the palette row's `<kbd>` gains a conflict style + title naming the other command; each settings row names its counterpart inline. Writes are never refused for conflicting — the disclosure is the entire mechanism (Rule Zero). First registry match wins deterministically.

**6. Menu: renderer projects, MAIN builds, clicks come back as ids.**
A pure `menuTemplate(catalogue, ctx, overrides)` in `commands.ts` returns protocol-typed serializable sections `{ id, label, accelerator?, enabled }`. The one runtime Zod schema in `@rennet/protocol` owns that wire shape; preload and MAIN parse update/run payloads, and an invalid update leaves the standing menu untouched. Windows/Linux translate `mod+` to `CmdOrCtrl+` with `registerAccelerator: false`. Electron does not honour that flag on macOS, so macOS command items omit the accelerator property entirely and show the shortcut as inert sublabel text. Renderer sends updates only when the serialized projection changes; MAIN wraps the parsed sections in standard roles and routes clicks back as parsed command ids. A raced, no-longer-live command id is dropped without a throw.

## Risks / Trade-offs

- [Double dispatch: menu accelerator + renderer keydown both fire] → Windows/Linux use `registerAccelerator: false`; macOS omits accelerator fields and renders inert sublabels. Workspace-handled registry chords stop propagation. Full-mount and main-template tests assert one run per press.
- [Menu updates on every context flicker] → the template is derived state from values `app.tsx` already holds; an effect posts only when the serialized template changes.
- [A stored chord that parses to nothing (garbage in config.json)] → `normalizeChord` returns null for an unrecognizable token; the command falls back to its default and the settings row shows the stored-but-unusable value honestly. Never a throw.
- [Catalogue refactor silently changing palette output] → existing `commands.test.ts` + `app.command-palette.dom.test.tsx` are the positive control; the refactor task runs them before any new behaviour lands.
- [`add-settings-v1` later wants the override store on the ladder] → the field is already the global layer's file; registering the key is additive in that change, no migration (Decision 1).

## Migration Plan

None: one additive-optional protocol field, additive `settings.get` output, one new command, one new IPC channel. Old configs parse unchanged. Rollback is reverting the change: the old `globalConfigSchema` is non-strict, so a config carrying `keybindings` still parses (the unknown key is stripped on parse, and thus dropped on the next old-build write) — an acceptable loss for a personal preference field.

## Open Questions

None.
