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
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
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

  // Derived rgba/hex parsers, so the table below reads the ACTUAL CSS, not a constant.
  const hexTriplet = (h: string): [number, number, number] => [
    channel(h, 0),
    channel(h, 1),
    channel(h, 2),
  ];
  const rgbaTriplet = (scope: string, name: string): [number, number, number] => {
    const m = block(scope).match(new RegExp(`${name}:[^;]*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+)`));
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined)
      throw new Error(`${name} rgba not found in ${scope}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };

  // Every derived translucent token re-derives its rgb from its base hex. Codex proved by
  // mutation that pinning only the base hexes left stale triplets (e.g. accent-soft still
  // on the old blue's rgb) green; this table reddens on any such drift. --private* derive
  // from --accent because --private: var(--accent).
  const DERIVED: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "--accent",
      ["--accent-soft", "--accent-soft-line", "--private-fill", "--private-line", "--private-glow"],
    ],
    ["--amber", ["--amber-fill", "--amber-line"]],
    ["--green", ["--green-fill", "--green-line"]],
  ];
  for (const scope of [DARK, LIGHT] as const) {
    const label = scope === DARK ? "dark" : "light";
    it(`every derived rgba tracks its base hex rgb (${label})`, () => {
      for (const [base, derived] of DERIVED) {
        const rgb = hexTriplet(hex(scope, base));
        for (const tok of derived) {
          expect(rgbaTriplet(scope, tok), `${tok} vs ${base} (${label})`).toEqual(rgb);
        }
      }
    });
  }

  it("--chrome-bg's base rgb is the DESIGN.md canvas anchor (both schemes)", () => {
    // Parsed from the CSS, not a constant: reverting --chrome-bg to the old moodboard rgb
    // (the "restoring old canvas anchor" mutation) reddens here.
    expect(rgbaTriplet(DARK, "--chrome-bg")).toEqual(hexTriplet(CANVAS[DARK]));
    expect(rgbaTriplet(LIGHT, "--chrome-bg")).toEqual(hexTriplet(CANVAS[LIGHT]));
  });

  it("additions take evidence green: --add-glyph aliases --green, legible on --add-fill", () => {
    expect(block(DARK)).toMatch(/--add-glyph:\s*var\(--green\)/);
    expect(block(LIGHT)).toMatch(/--add-glyph:\s*var\(--green\)/);
    // The green glyph renders over the opaque --add-fill row; keep it AA-legible.
    for (const scope of [DARK, LIGHT] as const) {
      expect(
        contrast(hex(scope, "--green"), hex(scope, "--add-fill")),
        `--green on --add-fill (${scope === DARK ? "dark" : "light"})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // ── Invariant guard: every amber TEXT clears AA on its RENDERED ground ───────
  // Wave-2's ratified light --amber (#a86125) clears AA (4.5:1) ONLY on --surface (4.61)
  // and --raised (4.77); it fails on the canvas anchor (4.26), --surface-2 (3.7-4.3),
  // --amber-fill and --amber-surface (~4.07). So every amber-TEXT site must be proven
  // against the background it ACTUALLY renders on — not the one it happens to self-set.
  //
  // The old guard only checked same-block backgrounds. Codex mutation-proved the hole:
  // adding `.collation-rollup { background: var(--amber-surface) }` to a PARENT left the
  // amber-text child green, because the child sets no background of its own. This guard
  // closes it: each amber-text selector declares the CONTAINER whose background is its
  // rendered ground, the ground token is READ FROM THE CSS (not trusted), and the contrast
  // is computed against it — so a container background flipped to amber reddens here.
  const readCss = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
  type Rule = { selector: string; body: string };
  const rules = (css: string): Rule[] => {
    const out: Rule[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec walk
    while ((m = re.exec(css)) !== null) {
      const raw = (m[1] ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim()
        .replace(/\s+/g, " ");
      out.push({ selector: raw, body: m[2] ?? "" });
    }
    return out;
  };
  // `color: var(--amber)` as a real TEXT colour — the negative lookbehind rejects
  // `border-color: var(--amber)` (a kept amber affordance is a border, not text ink).
  const amberText = (r: Rule): boolean => /(?<![\w-])color:\s*var\(--amber\)/.test(r.body);
  const allRules = [...rules(readCss("canvas.css")), ...rules(readCss("styles.css"))];

  // Every amber-TEXT selector that SURVIVES ink-ification, mapped to the container whose
  // background is its rendered ground and its kind. `text` must clear AA 4.5:1 on that
  // ground; `graphic` (a non-text mark — icon, spinner, error glyph) only the WCAG 1.4.11
  // graphics floor of 3:1. The container's background token is parsed from the CSS below,
  // so a ground that drifts to amber is caught. The discovered-set equality check keeps
  // coverage: ink-ifying reduces the set, and any NEW amber-text rule fails until mapped.
  const GROUND: Record<string, { container: string; kind: "text" | "graphic" }> = {
    // amber TEXT that clears AA on the --raised (#fff, 4.77:1) panels it renders on:
    ".ci-signal-failure-label": { container: ".ci-signal-panel", kind: "text" },
    ".ci-signal-body .ci-signal-incomplete": { container: ".ci-signal-panel", kind: "text" },
    ".hypothesis-panel-open": { container: ".hypothesis-panel", kind: "text" },
    ".hypothesis-degraded": { container: ".hypothesis-panel", kind: "text" },
    ".hypothesis-count-open": { container: ".hypothesis-panel", kind: "text" },
    ".settings-key-conflict": { container: ".settings-panel", kind: "text" },
    ".settings-key-recording-note, .settings-key-invalid": {
      container: ".settings-panel",
      kind: "text",
    },
    // non-text amber GRAPHICS on an amber ground (icon / spinner / error glyph), 3:1 floor:
    ".engine-fallback-icon": { container: ".engine-fallback", kind: "graphic" },
    ".processing-orb.is-failed": { container: ".processing-orb.is-failed", kind: "graphic" },
    '.processing-repo[data-state="error"] .processing-repo-icon': {
      container: '.processing-repo[data-state="error"]',
      kind: "graphic",
    },
  };

  const rgba = (scope: string, name: string): [number, number, number, number] => {
    const m = block(scope).match(new RegExp(`${name}:\\s*rgba\\(([^)]+)\\)`));
    if (!m || m[1] === undefined) throw new Error(`${name} rgba not found in ${scope}`);
    const p = m[1].split(",").map((x) => Number.parseFloat(x.trim()));
    if (p.length !== 4 || p.some((x) => Number.isNaN(x))) throw new Error(`${name} bad rgba`);
    return [p[0] as number, p[1] as number, p[2] as number, p[3] as number];
  };
  const composite = (fg: [number, number, number, number], bgHex: string): string => {
    const [r, g, b, a] = fg;
    const out = [r, g, b].map((c, i) => Math.round(c * a + channel(bgHex, i) * (1 - a)));
    return `#${out.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  };

  // Read the container's `background: var(--token)` from the CSS and resolve it to a light-
  // scheme hex (light --amber is the worst case). Solid tokens resolve directly; an rgba
  // ground composites over --surface. THIS is what makes a container background override bite.
  const bodyOf = (selector: string): string => {
    const r = allRules.find((x) => x.selector === selector);
    if (!r) throw new Error(`container rule not found: ${selector}`);
    return r.body;
  };
  const groundHex = (container: string): string => {
    const m = bodyOf(container).match(/background:\s*var\(--([a-z0-9-]+)\)/i);
    if (!m || m[1] === undefined) throw new Error(`no background token on ${container}`);
    const token = `--${m[1]}`;
    // Solid hex token → use it; rgba token → composite over --surface.
    if (new RegExp(`${token}:\\s*#`).test(block(LIGHT))) return hex(LIGHT, token);
    return composite(rgba(LIGHT, token), hex(LIGHT, "--surface"));
  };

  it("every amber-TEXT rule is mapped to a rendered ground — coverage stays exhaustive", () => {
    const discovered = [...new Set(allRules.filter(amberText).map((r) => r.selector))].sort();
    // Control: the discovery is not vacuous — amber-text rules still exist to classify.
    expect(discovered.length).toBeGreaterThan(5);
    // A new (or reverted-to-)amber-text rule not in GROUND reddens here.
    expect(discovered).toEqual(Object.keys(GROUND).sort());
  });

  it("each amber-TEXT selector clears its RENDERED-ground contrast floor (light, worst case)", () => {
    const amber = hex(LIGHT, "--amber");
    for (const [sel, { container, kind }] of Object.entries(GROUND)) {
      const ground = groundHex(container);
      const floor = kind === "graphic" ? 3 : 4.5;
      expect(
        contrast(amber, ground),
        `${sel}: amber on ${container} ground ${ground}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("the container grounds resolve to the expected tokens (the map is honest about the CSS)", () => {
    // Pins what each container renders, so a background flipped to amber (the Codex mutation
    // class) changes the resolved ground and the contrast test above goes red.
    expect(groundHex(".ci-signal-panel")).toBe(hex(LIGHT, "--raised"));
    expect(groundHex(".hypothesis-panel")).toBe(hex(LIGHT, "--raised"));
    expect(groundHex(".settings-panel")).toBe(hex(LIGHT, "--raised"));
    expect(groundHex(".engine-fallback")).toBe(hex(LIGHT, "--amber-surface"));
    expect(groundHex('.processing-repo[data-state="error"]')).toBe(hex(LIGHT, "--amber-surface"));
  });

  it("amber marks left on an amber ground are non-text graphics (3:1 floor, below AA text)", () => {
    const amber = hex(LIGHT, "--amber");
    const amberSurface = hex(LIGHT, "--amber-surface");
    const amberFill = composite(rgba(LIGHT, "--amber-fill"), hex(LIGHT, "--surface"));
    // Meets the graphics floor…
    expect(contrast(amber, amberSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(amber, amberFill)).toBeGreaterThanOrEqual(3);
    // …but is genuinely below AA text — which is why every TEXT site is ink-ified, not left amber.
    expect(contrast(amber, amberSurface)).toBeLessThan(4.5);
    expect(contrast(amber, amberFill)).toBeLessThan(4.5);
  });

  it("ink (--text) and sheet ink clear AA text on the amber grounds they now sit on", () => {
    const amberSurface = hex(LIGHT, "--amber-surface");
    const amberFillOnSurface = composite(rgba(LIGHT, "--amber-fill"), hex(LIGHT, "--surface"));
    const amberFillOnSheet = composite(rgba(LIGHT, "--amber-fill"), hex(LIGHT, "--sheet-bg"));
    expect(contrast(hex(LIGHT, "--text"), amberSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(LIGHT, "--text"), amberFillOnSurface)).toBeGreaterThanOrEqual(4.5);
    // The publish-sheet ledger keeps the sheet (paper) palette: its amber text ink-ifies to --sheet-text.
    expect(contrast(hex(LIGHT, "--sheet-text"), amberFillOnSheet)).toBeGreaterThanOrEqual(4.5);
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
