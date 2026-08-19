// The design-token transpose (issue #383). React Native cannot consume the web
// theme's CSS custom properties, so this file RE-STATES the same canonical values
// as plain strings RN styles read directly.
//
// SOURCE OF TRUTH: `packages/theme/src/theme.css` ("The Affineur's Bench", ratified
// 2026-08-19). Keep these values in sync with it BY HAND — there is no DOM here to
// inherit the `--rn-*` custom properties. When theme.css changes, mirror it here.
//
// The world: warm near-black dark / warm near-white light, ONE accent (gold) that is
// also the decision register (review blue and decision amber are retired — both fold
// into `accent`), plus evidence green and danger red. Serif is the review's voice on
// the desktop; here the interface is DM Sans and display titles are Fraunces.
//
// Pure and framework-free so it unit-tests without React Native: `resolveTheme(scheme)`
// returns the palette for a colour scheme; a thin RN hook (theme/use-theme) wraps it
// with Appearance.

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
  /** Accent tint fill (chips, callouts). */
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

const light: Palette = {
  canvas: "#fbfaf7",
  surface: "#ffffff",
  card: "#f3f1ec",
  ink: "#1e1b16",
  text: "#1e1b16",
  muted: "#57534a",
  faint: "#6b6558",
  line: "rgba(60,50,30,0.12)",
  line2: "rgba(60,50,30,0.2)",
  accent: "#8a5d0b",
  accentSoft: "#f6ecd6",
  accentLine: "rgba(138,93,11,0.32)",
  green: "#41745b",
  greenSoft: "rgba(65,116,91,0.12)",
  greenLine: "rgba(65,116,91,0.3)",
  danger: "#b23b2b",
  dangerSoft: "rgba(178,59,43,0.1)",
};

const dark: Palette = {
  canvas: "#0e0d0c",
  surface: "#151413",
  card: "#1b1a18",
  ink: "#f2ede4",
  text: "#f2ede4",
  muted: "#a9a196",
  faint: "#948d80",
  line: "rgba(240,232,215,0.09)",
  line2: "rgba(240,232,215,0.16)",
  accent: "#e8b13c",
  accentSoft: "#241c0e",
  accentLine: "rgba(232,177,60,0.35)",
  green: "#88bc9b",
  greenSoft: "rgba(136,188,155,0.14)",
  greenLine: "rgba(136,188,155,0.36)",
  danger: "#db7a6a",
  dangerSoft: "rgba(219,122,106,0.14)",
};

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

/** Loaded font families (see app/_layout.tsx `useFonts`). Interface text is DM Sans;
 *  display titles are Fraunces; code stays platform monospace (handled at the call site).
 *  RN bakes weight into the family name, so pick the family, not a `fontWeight`. */
export const fontFamily = {
  sans: "DMSans_400Regular",
  sansMedium: "DMSans_500Medium",
  sansSemibold: "DMSans_600SemiBold",
  display: "Fraunces_600SemiBold",
} as const;

export { dark as darkPalette, light as lightPalette };
