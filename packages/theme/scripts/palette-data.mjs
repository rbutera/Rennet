// Parse the canonical palette (src/palette.css) into data, and emit the mobile
// transpose from it. Used by BOTH the generator CLI (generate-mobile-palette.mjs)
// and palette-sync.test.ts, so the committed generated file can never drift from
// palette.css without reddening the gate.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PALETTE_CSS_PATH = join(here, "..", "src", "palette.css");

/** Vars that only make sense on the web (font stacks, box-shadow) — excluded
 *  from the mobile transpose. */
const WEB_ONLY = new Set([
  "--rn-font-sans",
  "--rn-font-serif",
  "--rn-font-display",
  "--rn-font-mono",
  "--rn-shadow-overlay",
]);

function sliceBlock(css, selectorStart) {
  const start = css.indexOf(selectorStart);
  if (start < 0) throw new Error(`palette.css: selector not found: ${selectorStart}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function declarations(block) {
  const out = new Map();
  for (const match of block.matchAll(/(--rn-[\w-]+):\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim().replace(/\s+/g, " "));
  }
  if (out.size === 0) throw new Error("palette.css: block parsed to zero declarations");
  return out;
}

/** `--rn-accent-fill` → `accentFill` */
function camel(name) {
  return name.replace(/^--rn-/, "").replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** `rgb(60 50 30 / 0.12)` → `rgba(60,50,30,0.12)` — React Native's safest form. */
function toReactNativeColor(value) {
  return value.replace(
    /rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/g,
    (_, r, g, b, a) => `rgba(${r},${g},${b},${a})`,
  );
}

/** The palette as data: { light: {accent: "#8a5d0b", …}, dark: {…} } (mobile keys). */
export function parsePalette(cssPath = PALETTE_CSS_PATH) {
  const css = readFileSync(cssPath, "utf8");
  const schemes = {
    light: declarations(sliceBlock(css, ":root {")),
    dark: declarations(sliceBlock(css, '[data-scheme="dark"],')),
  };
  const result = { light: {}, dark: {} };
  for (const [scheme, vars] of Object.entries(schemes)) {
    for (const [name, value] of vars) {
      if (WEB_ONLY.has(name)) continue;
      result[scheme][camel(name)] = toReactNativeColor(value);
    }
  }
  // Dark overrides only what differs? No — palette.css dark restates every color
  // var; verify parity so a missed override cannot emit a half-dark palette.
  const lightKeys = Object.keys(result.light).sort().join(",");
  const darkKeys = Object.keys(result.dark).sort().join(",");
  if (lightKeys !== darkKeys) {
    throw new Error(`palette.css: light/dark key mismatch:\n${lightKeys}\n${darkKeys}`);
  }
  return result;
}

/** The exact content of apps/mobile/src/theme/palette.generated.ts. */
export function emitMobilePalette(cssPath = PALETTE_CSS_PATH) {
  const palette = parsePalette(cssPath);
  const scheme = (name) =>
    Object.entries(palette[name])
      .map(([key, value]) => `    ${key}: "${value}",`)
      .join("\n");
  return `// GENERATED FILE — do not edit by hand.
// Source: packages/theme/src/palette.css (the one palette source of truth).
// Regenerate: pnpm nx run rennet-theme:generate
// Staleness reddens packages/theme/src/palette-sync.test.ts in the gate.

export const palette = {
  light: {
${scheme("light")}
  },
  dark: {
${scheme("dark")}
  },
} as const;

export type GeneratedScheme = keyof typeof palette;
export type GeneratedPalette = (typeof palette)["light"];
`;
}
