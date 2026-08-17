import type { MenuItemConstructorOptions } from "electron";

/**
 * The application menu, BUILT from the registry (#44). The renderer projects the
 * command catalogue + live context + overrides into serializable sections (the
 * `menuTemplate` in `@rennet/ui`) and sends them over IPC; this pure builder wraps
 * them in the standard Electron role scaffolding (the macOS app menu, Edit-role text
 * editing, Window controls) and turns each command item into a display-only entry
 * whose click routes back to the renderer as a command id.
 *
 * Command accelerators are DISPLAY-ONLY (`registerAccelerator: false`): the renderer
 * stays the single chord dispatcher, so a chord press runs the command exactly once
 * (the menu never double-fires it). `mod+` translates to Electron's `CmdOrCtrl+`.
 * Kept pure and Electron-free at the value level so it is unit-testable off-Electron.
 */

/** One projected menu item (the serializable shape the renderer sends). */
export interface MenuItemPayload {
  id: string;
  label: string;
  accelerator?: string;
  enabled: boolean;
}

/** One projected section (grouped by the command's registry group). */
export interface MenuSectionPayload {
  group: string;
  items: MenuItemPayload[];
}

/** Translate a platform-neutral `mod+` token to an Electron accelerator, else pass through. */
export function toAccelerator(token: string): string {
  return token.startsWith("mod+") ? `CmdOrCtrl+${token.slice("mod+".length)}` : token;
}

/**
 * Build the Electron application-menu template from the projected sections. Each
 * command item is display-only (`registerAccelerator: false`) and clicks back through
 * `onRun(id)`. The role scaffolding is standard Electron (never registry commands).
 */
export function buildApplicationMenu(
  sections: readonly MenuSectionPayload[],
  options: { isMac: boolean; onRun: (id: string) => void },
): MenuItemConstructorOptions[] {
  const { isMac, onRun } = options;
  const template: MenuItemConstructorOptions[] = [];

  // The macOS application menu (roles only) — the app name, hide/quit, etc.
  if (isMac) {
    template.push({ role: "appMenu" });
  }

  for (const section of sections) {
    template.push({
      label: section.group,
      submenu: section.items.map((item) => ({
        label: item.label,
        enabled: item.enabled,
        // Display-only: the renderer dispatches the chord, so the menu never registers
        // a key-equivalent that would double-fire the command.
        registerAccelerator: false,
        ...(item.accelerator ? { accelerator: toAccelerator(item.accelerator) } : {}),
        click: () => onRun(item.id),
      })),
    });
  }

  // Standard platform text-editing + window controls — Electron roles, not commands.
  template.push({ role: "editMenu" });
  template.push({ role: "windowMenu" });

  return template;
}
