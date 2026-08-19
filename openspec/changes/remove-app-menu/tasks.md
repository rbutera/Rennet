# Tasks: Remove the command-projected application menu

## 1. Protocol surface

- [ ] 1.1 Delete `menuTemplateItemSchema`, `menuTemplateSectionSchema`, `menuTemplateSectionsSchema`, and the `MenuTemplateSection` type from `packages/protocol/src/index.ts`; delete the `updateMenu` member from the preload contract type (~line 3027); remove their tests from `packages/protocol/src/index.test.ts`.

## 2. Renderer (packages/ui)

- [ ] 2.1 Delete `menuTemplate()` from `packages/ui/src/command/commands.ts` (and its `MenuTemplateSection` import); delete its tests in `packages/ui/src/command/commands.test.ts`.
- [ ] 2.2 Delete the menu-push effect in `packages/ui/src/app.tsx` (~line 2452: the `menuTemplate(...)` serialization and the `updateMenu` call) and the now-unused import.

## 3. Desktop main + preload

- [ ] 3.1 Rewrite `apps/desktop/src/main/menu.ts`: delete `buildApplicationMenu`, `applyMenuUpdate`, `toAccelerator`, and the accelerator-display workaround; add a pure `buildStaticMenu(isMac)` returning `[appMenu, editMenu, windowMenu]` roles for macOS and `null` (no menu) otherwise, unit-testable off-Electron.
- [ ] 3.2 In `apps/desktop/src/main/index.ts`: delete the `rennet:menu-update` channel constant and its `ipcMain` listener; at startup call `Menu.setApplicationMenu(buildFromTemplate(buildStaticMenu(true)))` on macOS and `Menu.setApplicationMenu(null)` on Windows/Linux.
- [ ] 3.3 In `apps/desktop/src/preload/index.ts`: delete `updateMenu` from the exposed bridge, the `MENU_UPDATE_CHANNEL` constant, and the schema import.
- [ ] 3.4 Replace `apps/desktop/src/main/menu.test.ts` projection/validation/accelerator tests with tests for `buildStaticMenu` (macOS: exactly the three roles, no command items; non-macOS: null).
- [ ] 3.5 Repo-wide grep for `MenuTemplateSection`, `menuTemplate`, `updateMenu`, `menu-update` — zero remaining references outside openspec history.

## 4. Docs (same-change obligation)

- [ ] 4.1 Rewrite the "The menu bar mirrors the palette" section of `docs/src/content/docs/using/guide/getting-started.md`: the palette (mod+k) and settings Keyboard section are the command surfaces; macOS menu is standard platform plumbing; Windows shows no menu strip.
- [ ] 4.2 Add a supersession note to the #44 entry in `docs/src/content/docs/developing/reference/delivery-order.md`: the application-menu projection described there was removed by `remove-app-menu`; palette/dispatch/settings remain catalogue-driven.
- [ ] 4.3 Grep `docs/` for other application-menu claims that this change falsifies; fix any found.

## 5. Gate

- [ ] 5.1 Run `pnpm check` (full gate) and fix anything it surfaces; confirm a positive control (deliberately broken test fails, then restore).
