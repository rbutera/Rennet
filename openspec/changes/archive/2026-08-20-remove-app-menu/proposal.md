# Remove the command-projected application menu

## Why

The application menu duplicates the command palette with a worse taxonomy: top-level menus are palette group names ("General", "Zoom", "Start" — several with one item), section order is catalogue declaration order, Edit/Window land after the custom menus, and there is no File/View/Go/Help. The palette is already the product's command surface and the renderer is already the sole chord dispatcher; the menu earns none of its plumbing (a renderer→main IPC projection, protocol schemas, and a display-only accelerator workaround that exists purely to avoid double dispatch).

## What Changes

- **BREAKING (internal surface)**: the registry-projected application menu is removed. macOS gets a static roles-only menu (`appMenu`, `editMenu`, `windowMenu`) set once at startup; Windows/Linux get `Menu.setApplicationMenu(null)` (no menu strip on the native frame; Alt menu access is deliberately gone).
- Delete the `menuTemplate()` projection in `@rennet/ui` and the renderer's menu push in `app.tsx`.
- Delete the `rennet:menu-update` IPC channel, the preload `updateMenu` bridge, and the `menuTemplateSectionSchema` / `MenuTemplateSection` / `updateMenu` contract slot in `@rennet/protocol`.
- Delete the menu-click return path too, now dead with no command items to click: the `rennet:menu-run` MAIN→renderer channel, the preload `onMenuRun` bridge, and `menuRunPayloadSchema` / `MenuRunPayload` in `@rennet/protocol`.
- Replace `apps/desktop/src/main/menu.ts` (registry builder, `applyMenuUpdate`, the platform accelerator-display workaround) with the static roles-only template; delete the tests that covered projection, validation, and accelerator display.
- Command discoverability remains the palette and the settings Keyboard section; `COMMAND_CATALOGUE`, key dispatch, keybinding overrides, and conflict disclosure are untouched — the catalogue simply loses its menu consumer.
- Docs updated in the same change: `getting-started.md` ("The menu bar mirrors the palette" section) and a supersession note on the `delivery-order.md` #44 entry.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `command-registry`: the requirement "The application menu is built from the registry" is removed (superseded — there is no command menu to build), and the "One registry feeds palette, dispatch, settings, and menu" requirement narrows to palette, dispatch, and settings. A new requirement pins the replacement posture: static platform-role menu on macOS, no application menu on Windows/Linux.

## Impact

- `packages/ui`: `menuTemplate()` + tests deleted; `app.tsx` menu-push effect deleted.
- `packages/protocol`: menu template schemas/types and the `updateMenu` contract member deleted (+ tests).
- `apps/desktop`: `main/menu.ts` reduced to a static roles template (macOS) / null (elsewhere); `main/index.ts` drops the `rennet:menu-update` listener; `preload` drops `updateMenu`; tests updated.
- Docs: `docs/src/content/docs/using/guide/getting-started.md`, `docs/src/content/docs/developing/reference/delivery-order.md`.
- Net large deletion; no new dependencies; no user-data or config impact (keybinding overrides unaffected).
