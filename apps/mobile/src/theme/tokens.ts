// The design-token transpose (issue #383). React Native cannot consume the web
// theme's CSS custom properties, so the palette arrives as GENERATED data:
// `palette.generated.ts` is emitted from packages/theme/src/palette.css (the one
// palette source of truth) by `pnpm nx run rennet-theme:generate`, and
// packages/theme/src/palette-sync.test.ts reddens the gate if it goes stale.
// This file only SHAPES that data into the mobile Palette vocabulary — it holds
// no colour values of its own.
//
// The world ("The Affineur's Bench", ratified 2026-08-19): warm near-black dark /
// warm near-white light, ONE accent (gold) that is also the decision register
// (review blue and decision amber are retired — both fold into `accent`), plus
// evidence green and danger red. Serif is the review's voice on the desktop;
// here the interface is Geist and display titles are Fraunces.
//
// Pure and framework-free so it unit-tests without React Native: `resolveTheme(scheme)`
// returns the palette for a colour scheme; a thin RN hook (theme/use-theme) wraps it
// with Appearance.

import { type GeneratedPalette, palette } from "./palette.generated";

export type ColorScheme = "light" | "dark";

export interface Palette {
  /** App backdrop. */
  readonly canvas: string;
  /** Raised surface (sheets, headers) — one step above the canvas. */
  readonly surface: string;
  /** Card fill (review rows, tiles, hunks). */
  readonly card: string;
  /** Primary text / the ink material. */
  readonly ink: string;
  /** Body text (same ink in this world). */
  readonly text: string;
  /** Secondary text. */
  readonly muted: string;
  /** Tertiary text (refs, timestamps). */
  readonly faint: string;
  /** Hairline divider. */
  readonly line: string;
  /** Stronger divider / control border. */
  readonly line2: string;
  /** Gold accent — the ONE accent and the decision register: links, information,
   *  selection, review structure, reconstructed decisions, disagreement. Text form
   *  (ochre in light, AA on white; gold in dark). */
  readonly accent: string;
  /** Accent tint fill (chips, callouts) — the solid accent-surface step. */
  readonly accentSoft: string;
  /** Accent border. */
  readonly accentLine: string;
  /** Evidence green — additions, current repo state, verified evidence. */
  readonly green: string;
  readonly greenSoft: string;
  readonly greenLine: string;
  /** Danger red — deletions, errors, destructive intent. */
  readonly danger: string;
  readonly dangerSoft: string;
}

/** Same keys as the generated palette, but widened from the literal hex types so
 *  both schemes flow through one shaper. */
type SchemeColors = { readonly [K in keyof GeneratedPalette]: string };

function shape(generated: SchemeColors): Palette {
  return {
    canvas: generated.canvas,
    surface: generated.surface,
    card: generated.raised,
    ink: generated.ink,
    text: generated.ink,
    muted: generated.inkSoft,
    faint: generated.inkFaint,
    line: generated.line,
    line2: generated.lineStrong,
    accent: generated.accent,
    accentSoft: generated.accentSurface,
    accentLine: generated.accentLine,
    green: generated.green,
    greenSoft: generated.greenSoft,
    greenLine: generated.greenLine,
    danger: generated.danger,
    dangerSoft: generated.dangerSoft,
  };
}

const light: Palette = shape(palette.light);
const dark: Palette = shape(palette.dark);

/** The palette for a colour scheme. Dark and light carry the SAME keys (checked in tests). */
export function resolveTheme(scheme: ColorScheme): Palette {
  return scheme === "dark" ? dark : light;
}

/** Corner radii, matched to the kit (micro/chip/control/surface/window). */
export const radii = { sm: 6, md: 8, lg: 11, xl: 14 } as const;

/** Spacing scale in points. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;

/** Type scale (points) and weights. */
export const type = {
  title: 23,
  heading: 18,
  body: 15,
  control: 13.5,
  chip: 12,
  pill: 11,
  weightRegular: "400",
  weightMedium: "500",
  weightSemibold: "600",
} as const;

/** Loaded font families (see app/_layout.tsx `useFonts`). Interface text is Geist;
 *  display titles are Fraunces; code stays platform monospace (handled at the call site).
 *  RN bakes weight into the family name, so pick the family, not a `fontWeight`. */
export const fontFamily = {
  sans: "Geist_400Regular",
  sansMedium: "Geist_500Medium",
  sansSemibold: "Geist_600SemiBold",
  display: "Fraunces_600SemiBold",
} as const;

export { dark as darkPalette, light as lightPalette };
