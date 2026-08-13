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
    // The base block now opens after `.rennet-glass {` (the token scope is
    // `.canvas-app, .rennet-glass` per issue #101, so both mount points share one
    // palette); the base custom-property block is the same.
    const dark = block(".rennet-glass {");
    // Backlight blue is the system's ONLY inner glow, private-to-reviewer.
    expect(dark).toContain("--private: #85c4dc");
    // Code stays fully opaque (never rides on the wallpaper).
    expect(dark).toContain("--code-bg: #14161b");
    // The single inner glow exists on the private token.
    expect(dark).toContain("--private-glow: inset");
  });

  it("composes the bright-room (light) scheme rather than inverting it", () => {
    const light = block('.rennet-glass[data-scheme="light"] {');
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

describe("real desktop glass + solid content (issue #61, the #115 correction)", () => {
  const canvas = readFileSync(fileURLToPath(new URL("./canvas.css", import.meta.url)), "utf8");

  it("drops the synthetic wallpaper gradient the glass now composites over the real desktop", () => {
    // #115's over-transparency and the earlier synthetic aurora are both gone: the
    // app backdrop is a frosted-chrome material, not a painted in-app gradient.
    expect(tokens).not.toContain("--wallpaper-img");
    expect(tokens).not.toContain("--wallpaper:");
    expect(tokens).toContain("--chrome-bg:");
    // The canvas root frosts the real desktop rather than painting a wallpaper.
    expect(canvas).toContain("background: var(--chrome-bg)");
    expect(canvas).not.toContain("background-image: var(--wallpaper-img)");
  });

  it("makes content-card surfaces SOLID/opaque so text never rides the wallpaper", () => {
    const dark = block(".rennet-glass {");
    // --raised and --surface are the solid content fills (cards, cohorts, panels).
    // A solid 6-digit hex is opaque; an rgba wash (the #115 failure) is not.
    expect(dark).toMatch(/--raised:\s*#[0-9a-f]{6};/i);
    expect(dark).toMatch(/--surface:\s*#[0-9a-f]{6};/i);
    // Whole-card state surfaces are solid too (blast cohort, private tray/ask).
    expect(dark).toMatch(/--amber-surface:\s*#[0-9a-f]{6};/i);
    expect(dark).toMatch(/--private-surface:\s*#[0-9a-f]{6};/i);
    // Positive control: the opaque code body is still present and solid.
    expect(dark).toContain("--code-bg: #14161b");
  });
});

describe("dark paper — the R40 fix: paper is materiality (warmth + opacity), not a fixed light colour", () => {
  it("makes the dark (default) paper WARM-DARK espresso, not cream", () => {
    const dark = block(".rennet-glass {");
    // The bug #99 named: cream paper on a near-black app. The dark default paper is
    // now warm-dark espresso with warm off-white ink. If the base still carried the
    // cream `#f7f5ef`, this reddens.
    expect(dark).toContain("--sheet-bg: #1c1712");
    expect(dark).toContain("--sheet-text: #efe7db");
    expect(dark).not.toContain("--sheet-bg: #f7f5ef");
  });

  it("keeps the bright-room paper CREAM (warmth returns in a light room)", () => {
    const light = block('.rennet-glass[data-scheme="light"] {');
    // The cream moved here (from the base) — the bright room keeps warm cream.
    expect(light).toContain("--sheet-bg: #f7f5ef");
    expect(light).toContain("--sheet-text: #23211c");
  });

  it("themes the paper PER SCHEME — the two --sheet-bg values differ", () => {
    // The whole point: paper themes rather than being one fixed colour. If both
    // scopes carried the same --sheet-bg (the pre-R40 bug), this reddens.
    const darkBg = block(".rennet-glass {").match(/--sheet-bg:\s*(#[0-9a-f]+)/i)?.[1];
    const lightBg = block('.rennet-glass[data-scheme="light"] {').match(
      /--sheet-bg:\s*(#[0-9a-f]+)/i,
    )?.[1];
    expect(darkBg).toBeDefined();
    expect(lightBg).toBeDefined();
    expect(darkBg).not.toBe(lightBg);
  });
});

describe("chrome type contract — no monospace as UI chrome (resteer fresh update 2 / #62)", () => {
  const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
  const canvas = readFileSync(fileURLToPath(new URL("./canvas.css", import.meta.url)), "utf8");

  it("aliases --mono to the proportional --sans so legacy chrome refs are not monospace", () => {
    // The v3 wireframe kit's mechanism: --mono aliases sans, so every existing chrome
    // reference (paths, branches, counts, badges, anchors, paper) flips automatically.
    expect(block(".rennet-glass {")).toContain("--mono: var(--sans)");
  });

  it("uses the complementary Rennet display and reading families", () => {
    const tokens = block(".rennet-glass {");
    expect(tokens).toContain(
      '--sans: "Avenir Next", "Source Sans 3 Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    );
    expect(tokens).toContain(
      '--display: "Helvetica Neue", "Instrument Sans Variable", Arial, sans-serif',
    );
  });

  it("reserves a separate --code token for the real monospace stack (code/diff only)", () => {
    expect(block(".rennet-glass {")).toMatch(/--code:\s*ui-monospace/);
  });

  it("routes the genuine code surfaces (raw diff, CodeView rows) at --code, not --mono", () => {
    // Positive control: the raw diff and the inhabited diff rows are real code.
    expect(styles).toContain("1.55 var(--code)");
    expect(canvas).toContain("1.5 var(--code)");
  });

  it("leaves no --mono font reference stranded now that --mono is sans", () => {
    // A --mono reference is harmless (it resolves to sans), but a genuine CODE
    // surface stranded on --mono would silently lose monospace. Guard the two known
    // code surfaces are the ONLY ones that ever needed it by asserting they moved.
    expect(styles).not.toMatch(/\.diff\s*\{[^}]*var\(--mono\)/);
    expect(canvas).not.toMatch(/\.code-view-row\s*\{[^}]*var\(--mono\)/);
  });
});
