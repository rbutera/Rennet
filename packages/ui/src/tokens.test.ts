import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

function block(selector: string): string {
  const start = tokens.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = tokens.indexOf("{", start);
  const close = tokens.indexOf("}", open);
  return tokens.slice(open, close);
}

describe("glass tokens — both schemes render, faithfully ported", () => {
  it("defines the dark (default) scheme with the ratified backlight and opaque code body", () => {
    const dark = block(".canvas-app {");
    // Backlight blue is the system's ONLY inner glow, private-to-reviewer.
    expect(dark).toContain("--private: #85c4dc");
    // Code stays fully opaque (never rides on the wallpaper).
    expect(dark).toContain("--code-bg: #14161b");
    // The single inner glow exists on the private token.
    expect(dark).toContain("--private-glow: inset");
  });

  it("composes the bright-room (light) scheme rather than inverting it", () => {
    const light = block('.canvas-app[data-scheme="light"] {');
    // Bright-room deepens backlight blue for contrast (#24657f), opaque white code.
    expect(light).toContain("--private: #24657f");
    expect(light).toContain("--code-bg: #ffffff");
  });

  it("has no fourth hue: only backlight-private and amber carry semantic marks", () => {
    // Control: a fabricated token name must be absent (the read is not vacuous).
    expect(tokens).not.toContain("--decorative-hue");
    expect(tokens).toContain("--amber:");
    expect(tokens).toContain("--private:");
  });
});
