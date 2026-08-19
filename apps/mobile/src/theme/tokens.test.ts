import { describe, expect, it } from "vitest";
import { palette } from "./palette.generated";
import { darkPalette, lightPalette, resolveTheme } from "./tokens";

describe("theme tokens (task 3.2 — kit transpose)", () => {
  it("light and dark palettes carry exactly the same keys", () => {
    expect(Object.keys(lightPalette).sort()).toEqual(Object.keys(darkPalette).sort());
  });

  it("resolveTheme picks the scheme's palette", () => {
    expect(resolveTheme("light")).toBe(lightPalette);
    expect(resolveTheme("dark")).toBe(darkPalette);
  });

  it("shapes the GENERATED palette — no hand-held colour values (blue/amber retired)", () => {
    // The values themselves are proven against palette.css by
    // packages/theme/src/palette-sync.test.ts; here we prove the mobile shaping
    // actually consumes the generated transpose rather than local literals.
    expect(lightPalette.accent).toBe(palette.light.accent);
    expect(darkPalette.accent).toBe(palette.dark.accent);
    expect(lightPalette.card).toBe(palette.light.raised);
    expect(darkPalette.muted).toBe(palette.dark.inkSoft);
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
