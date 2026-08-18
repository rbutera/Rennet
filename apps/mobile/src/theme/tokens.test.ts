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

  it("keeps the canonical review-blue hue from the kit", () => {
    expect(lightPalette.blue).toBe("#396f96");
    expect(darkPalette.blue).toBe("#8bbddd");
  });

  it("every colour is a hex string", () => {
    for (const palette of [lightPalette, darkPalette]) {
      for (const value of Object.values(palette)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
