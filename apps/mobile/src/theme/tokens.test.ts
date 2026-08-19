import { describe, expect, it } from "vitest";
import { darkPalette, lightPalette, resolveTheme } from "./tokens";

describe("theme tokens (task 3.2 — kit transpose)", () => {
  it("light and dark palettes carry exactly the same keys", () => {
    expect(Object.keys(lightPalette).sort()).toEqual(Object.keys(darkPalette).sort());
  });

  it("resolveTheme picks the scheme's palette", () => {
    expect(resolveTheme("light")).toBe(lightPalette);
    expect(resolveTheme("dark")).toBe(darkPalette);
  });

  it("uses the canonical gold accent (blue retired, merged into accent)", () => {
    expect(lightPalette.accent).toBe("#8a5d0b");
    expect(darkPalette.accent).toBe("#e8b13c");
    expect("blue" in lightPalette).toBe(false);
    expect("amber" in lightPalette).toBe(false);
  });

  it("every colour is a hex or rgba string", () => {
    for (const palette of [lightPalette, darkPalette]) {
      for (const value of Object.values(palette)) {
        expect(value).toMatch(/^(#[0-9a-f]{6}|rgba?\([0-9.,\s]+\))$/);
      }
    }
  });
});
