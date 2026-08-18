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
    // Private/local-only folds into the review-blue family (no fourth hue): --private is
    // a derived tint of --accent, and the "backlight" read is carried by the inner glow.
    expect(dark).toContain("--private: var(--accent)");
    // Code stays fully opaque (never rides on the wallpaper).
    expect(dark).toContain("--code-bg: #14161b");
    // The single inner glow exists on the private token (kept as a state marker).
    expect(dark).toContain("--private-glow: inset");
  });

  it("composes the bright-room (light) scheme rather than inverting it", () => {
    const light = block('.rennet-glass[data-scheme="light"] {');
    // Bright-room private also folds into review blue (--private = var(--accent)), opaque white code.
    expect(light).toContain("--private: var(--accent)");
    expect(light).toContain("--code-bg: #ffffff");
  });

  it("has no fourth hue: private folds into review blue; only blue/amber/green carry marks", () => {
    // Control: a fabricated token name must be absent (the read is not vacuous).
    expect(tokens).not.toContain("--decorative-hue");
    expect(tokens).toContain("--amber:");
    expect(tokens).toContain("--green:");
    expect(tokens).toContain("--private:");
    // The old standalone "backlight blue" hue (#85c4dc / #24657f) is gone: privacy is now
    // a derived tint of review blue, so no decorative fourth hue exists (DESIGN.md §Semantic).
    expect(tokens).not.toContain("#85c4dc");
    expect(tokens).not.toContain("#24657f");
    expect(tokens).toMatch(/--private:\s*var\(--accent\)/);
  });
});

// Task D — reversion-red: computed WCAG contrast + ratified-hex reconciliation. The
// relative-luminance math is inlined so a token edit that drops --text-faint below AA, or
// drifts a semantic hue away from the root DESIGN.md, reddens here rather than shipping.
describe("computed contrast + ratified palette (DESIGN.md reconciliation)", () => {
  // WCAG 2.x relative luminance + contrast ratio (sRGB), ~15 lines, no dependency.
  const channel = (h: string, i: number): number => {
    const s = h.replace("#", "");
    const n = s.length === 3 ? [...s].map((c) => c + c).join("") : s;
    return Number.parseInt(n.slice(i * 2, i * 2 + 2), 16);
  };
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (h: string): number =>
    0.2126 * lin(channel(h, 0)) + 0.7152 * lin(channel(h, 1)) + 0.0722 * lin(channel(h, 2));
  const contrast = (a: string, b: string): number => {
    const [l1, l2] = [luminance(a), luminance(b)];
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  // Pull a 3/6-digit hex token value out of a scheme block.
  const hex = (scope: string, name: string): string => {
    const m = block(scope).match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`));
    if (!m || m[1] === undefined) throw new Error(`${name} not found in ${scope}`);
    return m[1];
  };

  const DARK = ".rennet-glass {";
  const LIGHT = '.rennet-glass[data-scheme="light"] {';
  // Neutral-ramp canvas anchor per scheme (root DESIGN.md §Colors: dark-canvas / light-canvas).
  // Not a solid token here — the desktop expresses canvas as the translucent --chrome-bg glass —
  // so its opaque base is asserted as a literal against DESIGN.md.
  const CANVAS = { [DARK]: "#0e1116", [LIGHT]: "#f4f2ed" } as const;

  for (const scope of [DARK, LIGHT] as const) {
    const label = scope === DARK ? "dark" : "light";
    it(`--text-faint clears AA 4.5:1 on --surface, --raised, and canvas (${label})`, () => {
      const faint = hex(scope, "--text-faint");
      for (const [bgName, bg] of [
        ["--surface", hex(scope, "--surface")],
        ["--raised", hex(scope, "--raised")],
        ["canvas", CANVAS[scope]],
      ] as const) {
        expect(contrast(faint, bg), `${label} --text-faint on ${bgName}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });

    it(`ink hierarchy holds: --text-faint is fainter than --text-soft than --text (${label})`, () => {
      const surface = hex(scope, "--surface");
      const [ink, muted, faint] = [
        contrast(hex(scope, "--text"), surface),
        contrast(hex(scope, "--text-soft"), surface),
        contrast(hex(scope, "--text-faint"), surface),
      ];
      // Faint reads quieter than muted, muted quieter than ink (ink > muted > faint contrast).
      expect(faint).toBeLessThan(muted);
      expect(muted).toBeLessThan(ink);
    });
  }

  it("semantic hexes match the root DESIGN.md ratified values", () => {
    // Literals read straight from root DESIGN.md §Colors / §Semantic roles. If a token
    // drifts from these (the P2 this fixes), the mismatch reddens here.
    expect(hex(DARK, "--accent")).toBe("#8bbddd"); // review blue, dark
    expect(hex(DARK, "--amber")).toBe("#dda664"); // decision amber, dark
    expect(hex(DARK, "--green")).toBe("#88bc9b"); // evidence green, dark
    expect(hex(LIGHT, "--accent")).toBe("#396f96"); // review blue, light
    expect(hex(LIGHT, "--amber")).toBe("#a86125"); // decision amber, light
    expect(hex(LIGHT, "--green")).toBe("#41745b"); // evidence green, light
    // Canvas/surface/ink/muted anchors match DESIGN.md §Colors too.
    expect(hex(DARK, "--surface")).toBe("#15191f");
    expect(hex(DARK, "--text")).toBe("#f1f0eb");
    expect(hex(DARK, "--text-soft")).toBe("#a8b0ba");
    expect(hex(LIGHT, "--surface")).toBe("#fcfbf8");
    expect(hex(LIGHT, "--text")).toBe("#111419");
    expect(hex(LIGHT, "--text-soft")).toBe("#59616b");
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

describe("deixis focus pulse (#79)", () => {
  const canvas = readFileSync(fileURLToPath(new URL("./canvas.css", import.meta.url)), "utf8");

  it("animates the focused row once and settles instead of leaving a static highlight", () => {
    const selector = ".code-view-row.cv-focus {";
    const start = canvas.indexOf(selector);
    expect(start).toBeGreaterThanOrEqual(0);
    const close = canvas.indexOf("}", start);
    const focus = canvas.slice(start, close);

    expect(focus).toMatch(/animation:\s*cv-focus-pulse\s+\d+ms\s+ease-out\s+1\s+both/);
    expect(focus).not.toMatch(/animation[^;]*infinite/);
    expect(canvas).toMatch(/@keyframes\s+cv-focus-pulse\s*{/);
    expect(canvas).toMatch(/100%\s*{[^}]*transparent[^}]*}/);
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
