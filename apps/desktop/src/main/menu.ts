import type { MenuItemConstructorOptions } from "electron";

/**
 * The application menu is now a STATIC platform affordance, not a projection of the
 * command registry (the registry-built menu was removed by `remove-app-menu`). The
 * command surfaces are the palette (mod+k) and the settings Keyboard section.
 *
 * macOS keeps the standard role scaffolding only: `appMenu` (app name, Hide/Quit/About),
 * `editMenu` (native Cmd+C/V/X in inputs), and `windowMenu` (minimize/zoom/window list).
 * Windows/Linux get no application menu at all — `buildStaticMenu` returns `null`, and
 * the caller passes that to `Menu.setApplicationMenu(null)`.
 *
 * Kept pure and Electron-free at the value level so it is unit-testable off-Electron.
 */
export function buildStaticMenu(isMac: boolean): MenuItemConstructorOptions[] | null {
  if (!isMac) return null;
  return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
}
