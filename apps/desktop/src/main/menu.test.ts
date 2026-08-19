import { describe, expect, it } from "vitest";
import { buildStaticMenu } from "./menu";

describe("buildStaticMenu", () => {
  it("returns exactly the three platform roles on macOS, no command items", () => {
    const template = buildStaticMenu(true);
    expect(template).not.toBeNull();
    const roles = template?.map((entry) => entry.role);
    expect(roles).toEqual(["appMenu", "editMenu", "windowMenu"]);
    // Roles only — nothing carries a label, submenu, or click (no projected commands).
    for (const entry of template ?? []) {
      expect(entry.label).toBeUndefined();
      expect(entry.submenu).toBeUndefined();
      expect(entry.click).toBeUndefined();
    }
  });

  it("returns null off macOS (no application menu on Windows/Linux)", () => {
    expect(buildStaticMenu(false)).toBeNull();
  });
});
