# Design: Remove the command-projected application menu

## Context

The current menu pipeline: `menuTemplate(ctx, overrides)` in `packages/app-ui/src/command/commands.ts` projects `COMMAND_CATALOGUE` + live context into `MenuTemplateSection[]`; an effect in `packages/app-ui/src/app.tsx` (~line 2452) serializes it and calls the preload `updateMenu`; preload validates with `menuTemplateSectionsSchema` and sends `rennet:menu-update`; `apps/desktop/src/main/index.ts` listens and calls `applyMenuUpdate` in `main/menu.ts`, which re-validates, wraps in role scaffolding, and installs via `Menu.setApplicationMenu`. Command items carry a display-only accelerator workaround (`registerAccelerator: false` off-macOS; inert `sublabel` text on macOS) so the renderer stays the sole chord dispatcher.

The menus this produces are palette groups verbatim (unidiomatic, several one-item menus, unconventional order). The palette + settings Keyboard section already cover command discoverability.

## Goals / Non-Goals

**Goals:**
- Roles-only static macOS menu (`appMenu`, `editMenu`, `windowMenu`) installed once at startup.
- No application menu at all on Windows/Linux (`Menu.setApplicationMenu(null)`).
- Delete the entire projection/IPC/schema pipeline and its tests.
- Docs corrected in the same change.

**Non-Goals:**
- No changes to the palette, key dispatch, `COMMAND_CATALOGUE`, keybinding overrides, conflict disclosure, or the settings Keyboard section.
- No File/View/Go/Help remap (direction A was considered and rejected: the palette is the command surface; the menu would remain a second, worse copy).
- No renaming of stale palette labels ("Go to Paper") — separate concern.
- No tray or context-menu changes (`tray.ts`, `context-menu.ts` untouched).

## Decisions

1. **Static menu set in MAIN at startup, no renderer involvement.** The menu no longer depends on renderer state, so the IPC push and both schema validations are dead weight. `main/menu.ts` shrinks to a pure `buildStaticMenu(isMac)` returning the roles template (macOS) — kept as a pure function so it stays unit-testable off-Electron, matching the existing pattern.
   - Alternative (rejected): keep `applyMenuUpdate` with empty sections — leaves the whole pipeline alive for nothing.
2. **`Menu.setApplicationMenu(null)` on Windows/Linux.** Removes the menu strip from the native frame. This also drops Electron's default menu accelerators and Alt-key menu access; accepted, because the renderer already dispatches every chord and the win32 frame is kept only for acrylic/snap.
   - Alternative (rejected): `autoHideMenuBar: true` — keeps a hidden Alt-summonable menu, i.e. a second dispatch surface we just decided not to maintain.
3. **Protocol surface deleted, not deprecated.** `menuTemplateItemSchema`, `menuTemplateSectionSchema`, `menuTemplateSectionsSchema`, `MenuTemplateSection`, and the `updateMenu` contract member are internal (renderer↔preload↔main); no external consumer exists, so removal is clean. Preload drops `updateMenu` from the exposed bridge and its contract type. The return path dies with it: with no command items in the menu, nothing in MAIN ever sends `rennet:menu-run`, so that channel, the preload `onMenuRun` member, `menuRunPayloadSchema`/`MenuRunPayload`, and the renderer's `onMenuRun` effect are deleted too.
4. **macOS keeps `appMenu`/`editMenu`/`windowMenu` roles only.** `editMenu` keeps native text editing (Cmd+C/V/X) working in inputs; `windowMenu` keeps minimize/zoom/window list; `appMenu` keeps Quit/Hide/About. No Help menu — nothing to put in it yet.
5. **Spec delta on `command-registry`.** Remove the menu-projection requirement and its scenarios; narrow the single-source requirement to palette/dispatch/settings; add a requirement stating the static-roles (macOS) / no-menu (win32/Linux) posture so a future reviewer knows it is deliberate, not an omission.

## Risks / Trade-offs

- [Windows users lose Alt menu access and any menu-strip affordance] → deliberate; palette (mod+k) and settings Keyboard section are the discoverability surfaces; getting-started docs updated to say so.
- [macOS menu loses command entries (e.g. no "Back" in a menu)] → all commands remain in the palette with the same chords; nothing becomes unreachable.
- [Deleting protocol types breaks a hidden consumer] → grep for `MenuTemplateSection`/`updateMenu`/`menu-update` across the repo is part of the tasks; typecheck + full gate catches stragglers.
- [Default-menu loss on win32 also removes Ctrl+Shift+I devtools accelerator in dev] → devtools remain reachable programmatically; dev-only nicety, accepted.

## Migration Plan

Single PR. No data, config, or persisted-state migration. Rollback = revert the PR.

## Open Questions

None.
