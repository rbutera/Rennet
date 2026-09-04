import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

// Invariants for the shared Affineur's Bench theme (root DESIGN.md, 2026-08-19).
// Ported from the retired packages/ui tokens.test.ts: computed WCAG contrast so a
// palette edit that drops legibility reddens here rather than shipping, plus the
// structural guards this file's duplication makes necessary.

// The raw values live in palette.css (theme.css is the Tailwind mapping over it).
const css = readFileSync(fileURLToPath(new URL("./palette.css", import.meta.url)), "utf8");

/** Slice a top-level block's declarations by its opening selector. */
function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector present: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

const LIGHT = block(":root {");
// Dark binds to both scheme vocabularies (data-scheme app/marketing, data-theme docs).
const DARK = block('[data-scheme="dark"],');
// The prefers-color-scheme fallback nests one deeper. Read its guard selector
// verbatim out of the file — anchored on the media query, NOT on the selector's
// shape — so the cascade tests below run the REAL string and cannot pass against
// a stale copy of it.
const FALLBACK_GUARD = css.match(
  /@media \(prefers-color-scheme: dark\) \{\s*(:root[^{]*?)\s*\{/,
)?.[1];
if (!FALLBACK_GUARD) throw new Error("palette.css: prefers-color-scheme guard not found");
const fallbackStart = css.indexOf(FALLBACK_GUARD);
const FALLBACK = css.slice(css.indexOf("{", fallbackStart), css.indexOf("}", fallbackStart));

function hex(scope: string, name: string): string {
  const m = scope.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`${name} not found as hex in scope`);
  return m[1];
}

// WCAG 2.x relative luminance + contrast (sRGB).
const channel = (h: string, i: number): number =>
  Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
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

describe("scheme structure", () => {
  it("the prefers-color-scheme fallback is an exact copy of the dark block", () => {
    // The fallback exists for surfaces that never stamp data-scheme. It is a
    // hand-maintained duplicate; any drift means system-dark users see a
    // different theme than stamped-dark users.
    const declarations = (s: string): string[] =>
      s
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("--rn-"))
        .sort();
    expect(declarations(FALLBACK)).toEqual(declarations(DARK));
  });

  it("every dark token has a light counterpart (no theme-only colors)", () => {
    // Font stacks are scheme-invariant by design (defined once on :root); every
    // OTHER light token must be overridden in dark, and dark must add nothing.
    const names = (s: string): string[] =>
      [...s.matchAll(/(--rn-[\w-]+):/g)]
        .map((m) => m[1] ?? "")
        .filter((name) => !name.startsWith("--rn-font-"))
        .sort();
    expect(names(DARK)).toEqual(names(LIGHT));
  });
});

// The OS-dark fallback used to be guarded by
// `:root:not([data-scheme="light"]):not([data-theme="light"])` — specificity (0,3,0),
// which OUTRANKED every theme pack's (0,2,0) selector on <html> whenever the OS was
// dark and the scheme was not explicitly light. That is the default state on a dark
// Mac, so picking a pack changed nothing. The guard must match ONLY an unstamped
// root, and `:where()` must zero its specificity so it can never outrank a pack.
describe("the OS-dark fallback guard yields to a stamped root", () => {
  const stamp = (attributes: Record<string, string>) => {
    const root = new Window().document.documentElement;
    for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
    return root;
  };

  it("carries zero specificity", () => {
    expect(FALLBACK_GUARD).toContain(":where(");
  });

  it("matches an unstamped root (the read is not vacuous)", () => {
    expect(stamp({}).matches(FALLBACK_GUARD)).toBe(true);
  });

  it("does NOT match a root the app or Starlight has stamped", () => {
    for (const stamped of [
      { "data-scheme": "dark" },
      { "data-scheme": "light" },
      { "data-theme": "dark" },
      { "data-theme": "light" },
    ]) {
      expect(stamp(stamped).matches(FALLBACK_GUARD), JSON.stringify(stamped)).toBe(false);
    }
  });

  it("a pack's dark selector owns the stamped root the guard let go", () => {
    const root = stamp({ "data-rn-theme": "dracula", "data-scheme": "dark" });
    expect(root.matches('[data-rn-theme="dracula"][data-scheme="dark"]')).toBe(true);
    expect(root.matches(FALLBACK_GUARD)).toBe(false);
  });
});

describe("retired hues stay retired", () => {
  it("contains no review blue and no decision amber from the glass world", () => {
    for (const retired of ["#8bbddd", "#396f96", "#dda664", "#a86125", "#0e1116", "#15191f"]) {
      expect(css.toLowerCase()).not.toContain(retired);
    }
    // Control: the accent family is present (the read is not vacuous).
    expect(css).toContain("--rn-accent:");
  });
});

describe("computed WCAG contrast", () => {
  for (const [label, scope] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    const canvas = hex(scope, "--rn-canvas");
    const surface = hex(scope, "--rn-surface");
    const raised = hex(scope, "--rn-raised");

    it(`ink-faint clears AA 4.5:1 on canvas, surface, and raised (${label})`, () => {
      const faint = hex(scope, "--rn-ink-faint");
      for (const [bg, value] of [
        ["canvas", canvas],
        ["surface", surface],
        ["raised", raised],
      ] as const) {
        expect(contrast(faint, value), `${label} ink-faint on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`ink hierarchy holds: faint < soft < ink (${label})`, () => {
      const [ink, soft, faint] = [
        contrast(hex(scope, "--rn-ink"), surface),
        contrast(hex(scope, "--rn-ink-soft"), surface),
        contrast(hex(scope, "--rn-ink-faint"), surface),
      ];
      expect(faint).toBeLessThan(soft);
      expect(soft).toBeLessThan(ink);
    });

    it(`accent TEXT clears AA on canvas and surface (${label})`, () => {
      // In light the text accent is the ochre, in dark the gold itself; either
      // way --rn-accent is the form components may set type in.
      const accent = hex(scope, "--rn-accent");
      expect(contrast(accent, canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
    });

    it(`accent-ink clears AA on the accent fill — the primary button reads (${label})`, () => {
      expect(
        contrast(hex(scope, "--rn-accent-ink"), hex(scope, "--rn-accent-fill")),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`accent-foreground clears AA on bg-accent — the kit menu/select focus reads (${label})`, () => {
      // --color-accent-foreground maps to --rn-surface, painted on bg-accent
      // (--rn-accent) by every dropdown/select focus row. accent-INK here would
      // be 3.21:1 in light (fails) — surface is the scheme-flipping pair.
      expect(
        contrast(hex(scope, "--rn-surface"), hex(scope, "--rn-accent")),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`diff glyphs clear AA on their rows (${label})`, () => {
      expect(contrast(hex(scope, "--rn-add-ink"), hex(scope, "--rn-add"))).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(hex(scope, "--rn-del-ink"), hex(scope, "--rn-del"))).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    it(`paper ink clears AA on the sheet (${label})`, () => {
      expect(
        contrast(hex(scope, "--rn-sheet-ink"), hex(scope, "--rn-sheet")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("ratified anchors (root DESIGN.md reconciliation)", () => {
  it("matches the ratified ground and accent hexes", () => {
    // Dark grounds are the desaturated neutral near-blacks (2026-08-28): the warm
    // originals read as too saturated and too bright at canvas size.
    expect(hex(DARK, "--rn-canvas")).toBe("#0a0a0a");
    expect(hex(DARK, "--rn-surface")).toBe("#131313");
    expect(hex(DARK, "--rn-accent")).toBe("#e8b13c");
    expect(hex(LIGHT, "--rn-canvas")).toBe("#fbfaf7");
    expect(hex(LIGHT, "--rn-surface")).toBe("#ffffff");
    expect(hex(LIGHT, "--rn-accent")).toBe("#8a5d0b");
    expect(hex(LIGHT, "--rn-accent-fill")).toBe("#e0a52e");
    // Evidence green carried over from the prior world by design.
    expect(hex(DARK, "--rn-green")).toBe("#88bc9b");
    expect(hex(LIGHT, "--rn-green")).toBe("#41745b");
  });
});

const packBlock = (css: string, selector: string): string => {
  const start = css.indexOf(selector);
  expect(start, `selector present: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
};

const PACK_IDS = ["catppuccin-mocha", "dracula", "github", "one-dark-pro"] as const;
const packCss = (id: string): string =>
  readFileSync(fileURLToPath(new URL(`./themes/${id}.css`, import.meta.url)), "utf8");

// ── The lens register ────────────────────────────────────────────────────────
// Five portable hue slots that carry lens identity on the bench and the lens rail.
// The bar here is WCAG 1.4.11 (3:1, non-text) rather than 4.5:1, and that is a
// deliberate narrowing, not a relaxation: a lens hue is only ever a MARK — a rule,
// a keel, a bar — never type, so 4.5:1 is not the applicable criterion. It would
// also be unmeetable without repainting each pack away from its own palette, which
// is the whole point of the slots. `packages/app-ui`'s lens-colour test is the other
// half: it forbids the hue reaching a text utility, so this bar stays the right one.
const LENS_SLOTS = ["red", "yellow", "blue", "green", "neutral"] as const;
/** Every theme and scheme that must bind the register, as (label, declarations). */
const LENS_SCOPES: readonly (readonly [string, string])[] = [
  ["rennet light", LIGHT],
  ["rennet dark", DARK],
  ...PACK_IDS.flatMap(
    (id) =>
      [
        [`${id} light`, packBlock(packCss(id), `[data-rn-theme="${id}"] {`)],
        [`${id} dark`, packBlock(packCss(id), `[data-rn-theme="${id}"][data-scheme="dark"]`)],
      ] as const,
  ),
];

describe("the lens register is complete, legible, and telling-apart", () => {
  it("covers every theme and both schemes (the sweep is not vacuous)", () => {
    // 5 themes × 2 schemes. If a pack is added and this list is not, the count
    // disagrees before any assertion below gets a chance to pass by not running.
    expect(LENS_SCOPES.length).toBe(10);
  });

  for (const [label, scope] of LENS_SCOPES) {
    it(`${label}: every lens slot clears 3:1 on canvas, surface and raised`, () => {
      const grounds = [
        ["canvas", hex(scope, "--rn-canvas")],
        ["surface", hex(scope, "--rn-surface")],
        ["raised", hex(scope, "--rn-raised")],
      ] as const;
      for (const slot of LENS_SLOTS) {
        // `hex` throws when the slot is missing, so completeness is checked here too.
        const value = hex(scope, `--rn-lens-${slot}`);
        for (const [name, ground] of grounds) {
          expect(
            contrast(value, ground),
            `${label} lens-${slot} on ${name}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`${label}: no two lens slots are the same colour`, () => {
      // The register exists to tell five parallel readers apart. A pack that binds
      // the same hue twice has silently merged two lenses, and every contrast
      // assertion above would still pass.
      const values = LENS_SLOTS.map((slot) => hex(scope, `--rn-lens-${slot}`));
      expect(new Set(values).size, `${label}: ${values.join(" ")}`).toBe(LENS_SLOTS.length);
    });
  }

  it("the 3:1 bar bites (positive control)", () => {
    // A hue a hair off its own ground fails the SAME assertion the sweep runs, so a
    // pack that binds an invisible lens colour cannot pass by luck.
    const ground = hex(LIGHT, "--rn-canvas");
    expect(contrast("#f7f5f2", ground)).toBeLessThan(3);
    expect(contrast(hex(LIGHT, "--rn-lens-blue"), ground)).toBeGreaterThanOrEqual(3);
  });
});

// A bundled theme pack (issue #481) meets the SAME contrast contract as the
// default or it doesn't ship. Each themes/<id>.css scopes light + dark blocks;
// we run the identical AA assertions the default does, per pack per scheme. A
// pack that lifts a muted grey too far, or picks an accent that fails on its
// grounds, reddens here.
describe("theme packs meet the same AA contrast contract", () => {
  for (const id of PACK_IDS) {
    const packCss = readFileSync(
      fileURLToPath(new URL(`./themes/${id}.css`, import.meta.url)),
      "utf8",
    );
    const scopes = [
      ["light", packBlock(packCss, `[data-rn-theme="${id}"] {`)],
      ["dark", packBlock(packCss, `[data-rn-theme="${id}"][data-scheme="dark"]`)],
    ] as const;

    for (const [label, scope] of scopes) {
      const canvas = hex(scope, "--rn-canvas");
      const surface = hex(scope, "--rn-surface");
      const raised = hex(scope, "--rn-raised");

      it(`${id} ${label}: ink-faint clears AA on canvas, surface, raised`, () => {
        const faint = hex(scope, "--rn-ink-faint");
        for (const [bg, value] of [
          ["canvas", canvas],
          ["surface", surface],
          ["raised", raised],
        ] as const) {
          expect(contrast(faint, value), `${id} ${label} faint on ${bg}`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      });

      it(`${id} ${label}: ink hierarchy holds faint < soft < ink`, () => {
        const [ink, soft, faint] = [
          contrast(hex(scope, "--rn-ink"), surface),
          contrast(hex(scope, "--rn-ink-soft"), surface),
          contrast(hex(scope, "--rn-ink-faint"), surface),
        ];
        expect(faint).toBeLessThan(soft);
        expect(soft).toBeLessThan(ink);
      });

      it(`${id} ${label}: accent TEXT and its foreground pair clear AA`, () => {
        // accent as type on canvas/surface, AND surface painted on bg-accent
        // (the kit's menu/select focus row) — contrast is symmetric, so the
        // accent-on-surface and surface-on-accent checks share one inequality.
        const accent = hex(scope, "--rn-accent");
        expect(contrast(accent, canvas)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(surface, accent)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${id} ${label}: accent-ink clears AA on the accent fill`, () => {
        expect(
          contrast(hex(scope, "--rn-accent-ink"), hex(scope, "--rn-accent-fill")),
        ).toBeGreaterThanOrEqual(4.5);
      });

      it(`${id} ${label}: diff glyphs clear AA on their rows`, () => {
        expect(contrast(hex(scope, "--rn-add-ink"), hex(scope, "--rn-add"))).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrast(hex(scope, "--rn-del-ink"), hex(scope, "--rn-del"))).toBeGreaterThanOrEqual(
          4.5,
        );
      });

      it(`${id} ${label}: paper ink clears AA on the sheet`, () => {
        expect(
          contrast(hex(scope, "--rn-sheet-ink"), hex(scope, "--rn-sheet")),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
