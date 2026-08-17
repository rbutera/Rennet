import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenu, type MenuSectionPayload, toAccelerator } from "./menu";

const sections: MenuSectionPayload[] = [
  {
    group: "Navigate",
    items: [
      { id: "nav.back", label: "Back", accelerator: "mod+[", enabled: true },
      { id: "zoom.in", label: "Zoom in", accelerator: "l", enabled: false },
    ],
  },
];

/** Find a submenu item by label across the built template's submenus. */
function findItem(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  for (const entry of template) {
    const submenu = entry.submenu;
    if (Array.isArray(submenu)) {
      const hit = submenu.find((item) => item.label === label);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("buildApplicationMenu (#44)", () => {
  it("translates mod+ to CmdOrCtrl+ and passes a bare key through", () => {
    expect(toAccelerator("mod+[")).toBe("CmdOrCtrl+[");
    expect(toAccelerator("mod+k")).toBe("CmdOrCtrl+k");
    expect(toAccelerator("l")).toBe("l");
  });

  it("wraps sections in the role scaffolding, command items display-only", () => {
    const onRun = vi.fn();
    const template = buildApplicationMenu(sections, { isMac: true, onRun });

    // macOS app menu + Edit + Window roles wrap the projected sections.
    const roles = template.map((entry) => entry.role).filter(Boolean);
    expect(roles).toContain("appMenu");
    expect(roles).toContain("editMenu");
    expect(roles).toContain("windowMenu");

    const back = findItem(template, "Back");
    expect(back?.accelerator).toBe("CmdOrCtrl+[");
    // Display-only: no key-equivalent registration → the renderer stays sole dispatcher.
    expect(back?.registerAccelerator).toBe(false);
    expect(back?.enabled).toBe(true);

    // An out-of-context command is disabled, not absent.
    const zoom = findItem(template, "Zoom in");
    expect(zoom).toBeDefined();
    expect(zoom?.enabled).toBe(false);
  });

  it("routes an item click back through onRun with the command id", () => {
    const onRun = vi.fn();
    const template = buildApplicationMenu(sections, { isMac: false, onRun });
    // No app menu off macOS.
    expect(template.map((entry) => entry.role)).not.toContain("appMenu");

    const back = findItem(template, "Back");
    const click = back?.click as (() => void) | undefined;
    click?.();
    expect(onRun).toHaveBeenCalledWith("nav.back");
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});
