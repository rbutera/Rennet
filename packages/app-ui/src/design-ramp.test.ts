import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The desktop design ramp, utility edition (2026-08-19 overhaul). Components
// style themselves with Tailwind utilities backed by @rennet/theme; the ramp is
// the enumerated set of text-* utilities in packages/ui/DESIGN.md. What used to
// be "no off-ramp font-size px in the CSS" is now "no arbitrary-value escapes
// in the sources": an arbitrary text size, radius, or color is a
// split-the-difference nudge or a fourth hue smuggled past the theme.

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [path] : [];
  });
}

const BANS: ReadonlyArray<readonly [RegExp, string]> = [
  // Arbitrary text utilities: sizes AND colors ride the same escape hatch.
  [/\btext-\[/, "arbitrary text-[…] (use the ramp: text-2xs…text-2xl, text-display)"],
  // Arbitrary radius: the radius scale is rounded-micro…rounded-window (+full).
  [/\brounded(?:-[trbse]{0,2})?-\[/, "arbitrary rounded-[…] (use the radius scale)"],
  // Colors outside the theme. Dimension arbitraries (w-[340px]) stay legal;
  // only literal color payloads are escapes.
  [
    /\b(?:bg|border|ring|fill|stroke|from|via|to|caret|accent|outline|decoration|divide|shadow)-\[(?:#|rgb|hsl|oklch|color:)/,
    "arbitrary color (every color comes from @rennet/theme)",
  ],
  // Inline style font sizing bypasses the ramp entirely.
  [/fontSize\s*:/, "inline fontSize (use the ramp utilities)"],
];

// The two decorative micro-type declarations that sit BELOW the ramp's 10px
// floor, named by selector and pinned to their exact value. Both live in the
// first-run welcome's appearance stage and render illegible faux-code as
// texture, not as text:
//
//   .rn-code-fragment       9px  the code-rain fragments drifting behind the
//                                theme picker (`.rn-code-field`, opacity .52)
//   .rn-theme-preview code  8px  the faux-diff miniature inside a ~100px-wide
//                                theme preview card
//
// Neither is read at any size, so widening the ramp to 8/9px would sanction
// unreadable type everywhere to license two ornaments. Nothing else may use
// these values: the map is keyed on the selector AND the declaration value, so
// a third site, or a drift in either of these two, reddens the test.
const DECORATIVE_MICRO_TYPE: ReadonlyMap<string, string> = new Map([
  [".rn-code-fragment", "9px / 1.62 var(--font-mono)"],
  [".rn-theme-preview code", "8px / 1.8 var(--font-mono)"],
]);

// The selector of the rule containing `index` — the text between the previous
// block/declaration boundary and the enclosing `{`.
function selectorOf(css: string, index: number): string {
  const open = css.lastIndexOf("{", index);
  const before = css.slice(0, open);
  const start = Math.max(before.lastIndexOf("}"), before.lastIndexOf("{"), before.lastIndexOf(";"));
  return before.slice(start + 1).trim();
}

describe("desktop design ramp (utility contracts)", () => {
  it("keeps every source on the enumerated ramp — no arbitrary escapes", () => {
    const files = sources(SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
    expect(files.length).toBeGreaterThan(20); // positive control: the walk found the package
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
    // `font:` shorthand sizes type as surely as `font-size:` does, and a
    // font-size-only matcher let three of them through (8/9/12px mono) until
    // 2026-08-30. Both forms are checked; the shorthand may also be `inherit`.
    const offRamp = [...entry.matchAll(/\bfont(-size)?:\s*([^;]+);/g)].filter(
      ([, sizeSuffix, rawValue]) => {
        const value = (rawValue ?? "").trim();
        const onRamp =
          sizeSuffix === "-size"
            ? /^var\(--text-[\w-]+\)$/.test(value)
            : value === "inherit" || /\bvar\(--text-[\w-]+\)/.test(value);
        return !onRamp;
      },
    );
    const exempted = offRamp.filter(
      (match) => DECORATIVE_MICRO_TYPE.get(selectorOf(entry, match.index)) !== match[2]?.trim(),
    );
    expect(exempted.map((m) => m[0]).join("\n")).toBe("");
  });

  it("the ramp utilities documented in DESIGN.md exist in the shared theme", () => {
    const design = readFileSync(join(SRC, "..", "DESIGN.md"), "utf8");
    const theme = readFileSync(join(SRC, "..", "..", "theme", "src", "theme.css"), "utf8");
    // 10, 2xs, 12-5, 13, 15 and display are Rennet-defined; the rest are
    // Tailwind defaults. text-15 (chat/review prose) and text-12-5 (dense body)
    // joined the ramp with the prototype convergence, 2026-08-30.
    expect(design).toContain("text-2xs");
    expect(design).toContain("text-display");
    expect(design).toContain("text-12-5");
    expect(design).toContain("text-15");
    expect(theme).toContain("--text-2xs: 0.6875rem");
    expect(theme).toContain("--text-12-5: 0.78125rem");
    expect(theme).toContain("--text-15: 0.9375rem");
    expect(theme).toContain("--text-display: clamp(2.125rem, 5vw, 3.5rem)");
    // Sans-by-default prose voice, aliased so a serif experiment is one edit.
    expect(theme).toContain("--font-prose: var(--rn-font-sans)");
  });
});
