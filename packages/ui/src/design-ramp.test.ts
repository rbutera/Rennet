import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The desktop design ramp, kit edition. Same contract as packages/app-ui's copy,
// pointed at the vendored kit: components style themselves with Tailwind utilities
// backed by @rennet/theme; an arbitrary text size, radius, or color is a
// split-the-difference nudge or a fourth hue smuggled past the theme. Vendored
// shadcn code is post-pull mapped onto the ramp; this test keeps re-pulls honest.

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [path] : [];
  });
}

// Every Tailwind utility prefix that can take a color payload. Shared across all
// three color bans so a prefix (shadow-, placeholder-, accent-) can't be a
// bypass on one ban while banned on another (Tailwind emits shadow-red-500,
// shadow-black, accent-black, placeholder-[#…]).
const COLOR_PREFIX =
  "bg|text|border|ring|fill|stroke|from|via|to|caret|accent|outline|decoration|divide|placeholder|shadow";

const BANS: ReadonlyArray<readonly [RegExp, string]> = [
  // Arbitrary text utilities: sizes AND colors ride the same escape hatch.
  [/\btext-\[/, "arbitrary text-[…] (use the ramp: text-2xs…text-2xl, text-display)"],
  // Named off-ramp text sizes: the ramp stops at text-2xl (+ text-display).
  // text-3xl and up are Tailwind defaults, untracked by the Rennet scale.
  [/\btext-(?:[3-9]|\d\d)xl\b/, "off-ramp text size (ramp stops at text-2xl / text-display)"],
  // Arbitrary radius: the radius scale is rounded-micro…rounded-window (+full),
  // plus the shadcn aliases rounded-sm…rounded-2xl (Wave 1).
  [/\brounded(?:-[trbse]{0,2})?-\[/, "arbitrary rounded-[…] (use the radius scale)"],
  // Named off-ramp radius: the scale stops at rounded-2xl. rounded-3xl/4xl… are
  // Tailwind defaults with no --radius-* token (base-nova pulls ship these).
  [
    /\brounded(?:-[trbse]{0,2})?-(?:[3-9]|\d\d)xl\b/,
    "off-ramp radius rounded-Nxl (use rounded-sm…2xl / micro…window / full)",
  ],
  // Colors outside the theme. Dimension arbitraries (w-[340px]) stay legal;
  // only literal color payloads are escapes — including a color-function
  // (color-mix/oklab/lab/lch) wrapped inside the bracket, which the bare
  // #|rgb|hsl|oklch anchor misses (a base-nova hover default did exactly this).
  // Every color-capable utility prefix must be listed on ALL three color bans;
  // an omission (e.g. shadow-, placeholder-) is a live Tailwind bypass.
  [
    new RegExp(`\\b(?:${COLOR_PREFIX})-\\[(?:#|rgb|hsl|oklch|oklab|lab|lch|color-mix|color:)`),
    "arbitrary color (every color comes from @rennet/theme)",
  ],
  // Named Tailwind palette colors with a numeric shade (bg-red-500, text-zinc-400).
  // Rennet's own `green`/`danger`/`accent` are shadeless semantic tokens, so the
  // `-\d` shade is what marks a raw Tailwind palette color, not a theme token.
  [
    new RegExp(
      `\\b(?:${COLOR_PREFIX})-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d`,
    ),
    "raw Tailwind palette color (every color comes from @rennet/theme)",
  ],
  // Tailwind's bare black/white — off-theme (Rennet uses surface/canvas/ink/scrim).
  // `transparent`/`current`/`inherit` are keywords, not colors, and stay legal.
  [
    new RegExp(`\\b(?:${COLOR_PREFIX})-(?:black|white)(?![\\w-])`),
    "raw black/white (use a --rn-* backed token: surface/canvas/ink/scrim)",
  ],
  // Inline style font sizing bypasses the ramp entirely.
  [/fontSize\s*:/, "inline fontSize (use the ramp utilities)"],
];

// Positive control per ban: each known-bad form must be caught by SOME ban, so
// deleting any single BANS entry leaves one of these uncaught and reddens the
// suite (the delivery-order positive-control rule, applied to the guard itself).
const MUST_REJECT: readonly string[] = [
  "text-[13px]", // arbitrary text-[…]
  "text-3xl", // named off-ramp text size
  "rounded-[10px]", // arbitrary rounded-[…]
  "rounded-4xl", // named off-ramp radius
  "bg-[#abcdef]", // bracket color (hex)
  "hover:bg-[color-mix(in_oklch,var(--a),var(--b)_5%)]", // bracket color (function)
  "bg-red-500", // raw Tailwind palette color
  "shadow-red-500", // raw palette on the shadow prefix (a Tailwind bypass)
  "bg-black/10", // raw black/white
  "shadow-black", // bare black on the shadow prefix
  "accent-white", // bare white on the accent prefix
  "placeholder-[#abcdef]", // bracket color on the placeholder prefix
  "style={{ fontSize: 12 }}", // inline fontSize
];

describe("kit design ramp (utility contracts)", () => {
  it("keeps every source on the enumerated ramp — no arbitrary escapes", () => {
    const files = sources(SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
    expect(files.length).toBeGreaterThan(15); // positive control: the walk found the package
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [pattern, why] of BANS) {
        const match = text.match(pattern);
        if (match) {
          const line = text.slice(0, match.index ?? 0).split("\n").length;
          found.push(`${file.slice(SRC.length)}:${line} ${match[0]} — ${why}`);
        }
      }
    }
    expect(found, found.join("\n")).toEqual([]);
  });

  it("the entry stylesheet only sizes type through ramp variables", () => {
    const entry = readFileSync(join(SRC, "index.css"), "utf8");
    const offRamp = [...entry.matchAll(/font-size:\s*([^;]+);/g)].filter(
      ([, value]) => !/^var\(--text-[\w-]+\)$/.test((value ?? "").trim()),
    );
    expect(offRamp.map((m) => m[0]).join("\n")).toBe("");
  });

  it("every ban is exercised — each known-bad form is caught (positive control)", () => {
    for (const bad of MUST_REJECT) {
      const caught = BANS.some(([pattern]) => pattern.test(bad));
      expect(caught, `no ban caught: ${bad}`).toBe(true);
    }
  });

  it("the ramp utilities and shadcn radius aliases exist in the shared theme", () => {
    const theme = readFileSync(join(SRC, "..", "..", "theme", "src", "theme.css"), "utf8");
    // 2xs and display are Rennet-defined; the rest are Tailwind defaults.
    expect(theme).toContain("--text-2xs: 0.6875rem");
    expect(theme).toContain("--text-display: clamp(2.125rem, 5vw, 3.5rem)");
    // Wave 1 shadcn radius aliases the kit's rounded-sm…rounded-2xl resolve through.
    expect(theme).toContain("--radius-md: var(--radius-chip)");
  });
});
