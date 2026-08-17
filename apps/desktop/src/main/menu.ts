import { type MenuTemplateSection, menuTemplateSectionsSchema } from "@rennet/protocol";
import type { MenuItemConstructorOptions } from "electron";

/**
 * The application menu, BUILT from the registry (#44). The renderer projects the
 * command catalogue + live context + overrides into serializable sections (the
 * `menuTemplate` in `@rennet/ui`) and sends them over IPC; this pure builder wraps
 * them in the standard Electron role scaffolding (the macOS app menu, Edit-role text
 * editing, Window controls) and turns each command item into a display-only entry
 * whose click routes back to the renderer as a command id.
 *
 * Command shortcuts are display-only: Windows/Linux use `registerAccelerator: false`;
 * macOS omits native accelerators and shows inert sublabel text. The renderer stays
 * the single chord dispatcher. `mod+` translates to Electron's `CmdOrCtrl+` off macOS.
 * Kept pure and Electron-free at the value level so it is unit-testable off-Electron.
 */

/** Translate a platform-neutral `mod+` token to an Electron accelerator, else pass through. */
export function toAccelerator(token: string): string {
  return token.startsWith("mod+") ? `CmdOrCtrl+${token.slice("mod+".length)}` : token;
}

/**
 * Build the Electron application-menu template from the projected sections. Each
 * command item is display-only and clicks back through `onRun(id)`. The role
 * scaffolding is standard Electron (never registry commands).
 */
export function buildApplicationMenu(
  sections: readonly MenuTemplateSection[],
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
      submenu: section.items.map((item) => {
        const displayChord = item.accelerator
          ? item.accelerator.startsWith("mod+")
            ? `⌘${item.accelerator.slice("mod+".length)}`
            : item.accelerator
          : undefined;
        return {
          label: item.label,
          enabled: item.enabled,
          // macOS ignores registerAccelerator:false, so an accelerator property there
          // is a second native dispatcher. Render the chord as inert text instead.
          ...(isMac
            ? displayChord
              ? { sublabel: displayChord }
              : {}
            : {
                registerAccelerator: false,
                ...(item.accelerator ? { accelerator: toAccelerator(item.accelerator) } : {}),
              }),
          click: () => onRun(item.id),
        } satisfies MenuItemConstructorOptions;
      }),
    });
  }

  // Standard platform text-editing + window controls — Electron roles, not commands.
  template.push({ role: "editMenu" });
  template.push({ role: "windowMenu" });

  return template;
}

/** Parse and install one renderer menu update. Invalid input leaves the old menu intact. */
export function applyMenuUpdate<TMenu>(
  payload: unknown,
  options: {
    isMac: boolean;
    onRun(id: string): void;
    buildFromTemplate(template: MenuItemConstructorOptions[]): TMenu;
    setApplicationMenu(menu: TMenu): void;
  },
): boolean {
  const parsed = menuTemplateSectionsSchema.safeParse(payload);
  if (!parsed.success) return false;
  const template = buildApplicationMenu(parsed.data, options);
  const menu = options.buildFromTemplate(template);
  options.setApplicationMenu(menu);
  return true;
}
