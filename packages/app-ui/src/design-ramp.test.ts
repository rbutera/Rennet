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
    const offRamp = [...entry.matchAll(/font-size:\s*([^;]+);/g)].filter(
      ([, value]) => !/^var\(--text-[\w-]+\)$/.test((value ?? "").trim()),
    );
    expect(offRamp.map((m) => m[0]).join("\n")).toBe("");
  });

  it("the ramp utilities documented in DESIGN.md exist in the shared theme", () => {
    const design = readFileSync(join(SRC, "..", "DESIGN.md"), "utf8");
    const theme = readFileSync(join(SRC, "..", "..", "theme", "src", "theme.css"), "utf8");
    // 2xs and display are Rennet-defined; the rest are Tailwind defaults.
    expect(design).toContain("text-2xs");
    expect(design).toContain("text-display");
    expect(theme).toContain("--text-2xs: 0.6875rem");
    expect(theme).toContain("--text-display: clamp(2.125rem, 5vw, 3.5rem)");
  });
});
