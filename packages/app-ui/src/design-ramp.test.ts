import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The desktop design ramp, utility edition (2026-08-19 overhaul). Components
// style themselves with Tailwind utilities backed by @rennet/theme; the ramp is
// the enumerated set of text-* utilities in packages/app-ui/DESIGN.md. What used to
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
//                                theme picker (base opacity .58, overridden per
//                                fragment across .48–.82 by FRAGMENT_OPACITY in
//                                first-run-welcome.tsx, all of it under the
//                                field's own .72 on `.rn-code-field`)
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

// The ramp, harvested from the one place it is enumerated for humans — the type
// TABLE in this package's DESIGN.md — so the allowlist cannot drift from the
// documentation the way a hand-copied list would. Table rows ONLY (lines opening
// with `|`): the prose around the table names tokens in order to forbid them
// ("arbitrary `text-[…]` is off-ramp"), and harvesting the whole document turns
// every such sentence into a silent sanction for the token it warns about.
function rampVars(design: string): ReadonlySet<string> {
  return new Set(
    design
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .flatMap((row) =>
        [...row.matchAll(/`text-([a-z0-9-]+)`/g)].map(([, name]) => `--text-${name}`),
      ),
  );
}

const RAMP_VARS = rampVars(readFileSync(join(SRC, "..", "DESIGN.md"), "utf8"));

// The ramp, written out. The literal list IS the point: the harvest keeps the
// allowlist honest to DESIGN.md, and this keeps DESIGN.md honest to the ramp.
// Drift in EITHER direction — a step added to the table, a step quietly dropped
// — reddens here rather than widening or narrowing the test's idea of legal type.
const SANCTIONED_RAMP = [
  "--text-10",
  "--text-12-5",
  "--text-13",
  "--text-15",
  "--text-2xl",
  "--text-2xs",
  "--text-base",
  "--text-display",
  "--text-lg",
  "--text-sm",
  "--text-xl",
  "--text-xs",
];

function isRampSize(value: string): boolean {
  const named = /^var\((--text-[a-z0-9-]+)\)$/.exec(value);
  return named !== null && RAMP_VARS.has(named[1] ?? "");
}

// Everything the `font:` shorthand may carry BEFORE its size operand: style,
// variant, weight and stretch keywords, an `oblique <angle>`, and a bare number
// (a font-weight — CSS Fonts 4 allows any 1–1000, so `625` is legal and is not a
// size; a size always carries a unit or is an absolute-size keyword).
const FONT_SHORTHAND_PREFIX =
  /^(?:normal|italic|oblique|small-caps|bold|bolder|lighter|-?\d+(?:\.\d+)?(?:deg)?|(?:ultra-|extra-|semi-)?(?:condensed|expanded))$/;

// The SIZE operand of a `font:` shorthand. Not "a ramp var appears somewhere in
// the value" — `font: 17px/var(--text-xs) …` puts one in the line-height slot
// and sizes type at a raw 17px. Split on top-level whitespace and `/` (parens
// keep `var(…)` whole): with a slash, the size is the token before it;
// without one, it is the first token that is not a style/weight/stretch keyword.
//
// ponytail: the accepted grammar is deliberately narrow, and this is its ceiling.
// It understands style/variant/weight/stretch keywords, bare-number weights and
// `oblique <angle>` as prefixes, and requires the size operand to be a ramp
// `var(…)`. It is NOT a CSS parser: a quoted family name containing `/` or
// whitespace (`font: var(--text-15) "Fira/Code"`) will mis-tokenize, and the
// system-font shorthands (`font: menu`) are out of scope. This guards against an
// accidental off-ramp size in one hand-written stylesheet, not adversarial CSS.
// Upgrade path if that stops being true: postcss-value-parser.
function shorthandSize(value: string): string {
  const tokens: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && (/\s/.test(ch) || ch === "/")) {
      if (token) tokens.push(token);
      if (ch === "/") tokens.push("/");
      token = "";
      continue;
    }
    token += ch;
  }
  if (token) tokens.push(token);
  const slash = tokens.indexOf("/");
  if (slash > 0) return tokens[slash - 1] ?? "";
  return tokens.find((candidate) => !FONT_SHORTHAND_PREFIX.test(candidate)) ?? "";
}

// Every type-sizing declaration in `css` that is neither on the ramp nor one of
// the two pinned decorative micro-type exemptions. The trailing `;` is optional:
// a block's last declaration may omit it, and requiring it hid such a line.
function offRampFontDeclarations(source: string): string[] {
  // Comments come out ONCE, up front, and everything below reads the stripped
  // text so the match indices still line up for `selectorOf`. A comment can sit
  // anywhere a space can, so `font/**/: 17px system-ui` is a real declaration
  // that a raw-text matcher never sees; stripping also retires the mirror-image
  // false positive, a `/` inside prose being read as a shorthand size/line-height
  // separator.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...css.matchAll(/\bfont(-size)?\s*:\s*([^;{}]+);?/g)]
    .filter(([, sizeSuffix, rawValue]) => {
      const value = (rawValue ?? "").trim();
      // The shorthand may also be the `inherit` keyword, which sizes nothing new.
      if (sizeSuffix !== "-size" && value === "inherit") return false;
      return !isRampSize(sizeSuffix === "-size" ? value : shorthandSize(value));
    })
    .filter((match) => DECORATIVE_MICRO_TYPE.get(selectorOf(css, match.index)) !== match[2]?.trim())
    .map((match) => match[0].trim());
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
    // positive control: the DESIGN.md type table was actually harvested, and it
    // is exactly the sanctioned ramp — no more, no less.
    expect([...RAMP_VARS].sort()).toEqual(SANCTIONED_RAMP);
    const violations = offRampFontDeclarations(readFileSync(join(SRC, "index.css"), "utf8"));
    expect(violations.join("\n")).toBe("");
  });

  // Mutation controls for the matcher above: each of these got past the
  // font-size-only, semicolon-requiring, contains-a-ramp-var check it replaced.
  it("the type-sizing matcher rejects the shorthands the old check let through", () => {
    for (const declaration of [
      ".x { font: 17px/var(--text-xs) var(--font-mono); }", // ramp var in the line-height slot only
      ".x { font: var(--text-3xl) var(--font-mono); }", // off-ramp name
      ".x { font-size: var(--text-3xl) }", // off-ramp name, no trailing semicolon
      ".x { font: italic bold 17px var(--font-mono) }", // keyword prefix, raw px, no semicolon
      ".x { font/**/: 17px system-ui; }", // a comment where a space may sit, hiding `font:`
    ]) {
      expect(offRampFontDeclarations(declaration), declaration).not.toEqual([]);
    }
    // …and still accepts well-formed shorthands: prefix keywords, an oblique
    // angle, and a bare-number font-weight all precede the size operand.
    for (const declaration of [
      ".x { font: italic bold var(--text-15)/1.4 var(--font-mono) }",
      ".x { font: oblique 10deg var(--text-15) system-ui }",
      ".x { font: 625 var(--text-15) system-ui }",
    ]) {
      expect(offRampFontDeclarations(declaration), declaration).toEqual([]);
    }
  });

  it("harvests the ramp from the type table only, never from the prose around it", () => {
    const doc = [
      "Arbitrary sizes are off-ramp: never reach for `text-4xl`.",
      "",
      "| px | utility | role |",
      "|----|---------|------|",
      "| 16 | `text-base` | reading |",
    ].join("\n");
    // The prose mention must NOT sanction --text-4xl; only the table row counts.
    expect([...rampVars(doc)]).toEqual(["--text-base"]);
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
