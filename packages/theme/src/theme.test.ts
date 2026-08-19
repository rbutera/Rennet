import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// The prefers-color-scheme fallback nests one deeper; slice from its guard selector.
const fallbackStart = css.indexOf(':root:not([data-scheme="light"])');
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
    expect(hex(DARK, "--rn-canvas")).toBe("#0e0d0c");
    expect(hex(DARK, "--rn-surface")).toBe("#151413");
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
