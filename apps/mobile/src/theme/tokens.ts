// The design-token transpose (issue #383 M1, task 3.2). The desktop kit's visual
// language — the ink-vs-blue material law, the three functional hues, the neutral ramp,
// the radii and type scale — expressed as plain values React Native styles consume. This
// is NOT a port of `packages/ui` (DOM-bound, unusable in RN): it re-states the SAME
// canonical hexes (root DESIGN.md / `wireframes/src/kit.mjs`) as a native theme module.
//
// Pure and framework-free so it unit-tests without React Native: `resolveTheme(scheme)`
// returns the palette for a colour scheme; a thin RN hook (theme/use-theme) wraps it with
// Appearance. Three functional hues only (blue = review structure, amber = decisions,
// green = evidence/additions) — no decorative fourth, exactly as the kit mandates.

export type ColorScheme = "light" | "dark";

export interface Palette {
  /** App backdrop. */
  readonly canvas: string;
  /** Raised surface (sheets, headers). */
  readonly surface: string;
  /** Card fill. */
  readonly card: string;
  /** Primary text / the ink material. */
  readonly ink: string;
  /** Body text. */
  readonly text: string;
  /** Secondary text. */
  readonly muted: string;
  /** Tertiary text (refs, timestamps). */
  readonly faint: string;
  /** Hairline divider. */
  readonly line: string;
  /** Stronger divider / control border. */
  readonly line2: string;
  /** Review blue — links, information, selection, review structure. */
  readonly blue: string;
  readonly blueInk: string;
  readonly blueBg: string;
  readonly blueLine: string;
  /** Decision amber — reconstructed decisions, disagreement. */
  readonly amber: string;
  readonly amberBg: string;
  readonly amberLine: string;
  /** Evidence green — additions, current repo state, verified evidence. */
  readonly green: string;
  readonly greenBg: string;
  readonly greenLine: string;
}

const light: Palette = {
  canvas: "#e7e9ec",
  surface: "#f4f5f7",
  card: "#ffffff",
  ink: "#181b1f",
  text: "#1c1f24",
  muted: "#697079",
  faint: "#9aa1a9",
  line: "#e1e5e9",
  line2: "#d2d7dd",
  blue: "#396f96",
  blueInk: "#2f6491",
  blueBg: "#e9f1f8",
  blueLine: "#c2d8e9",
  amber: "#a86125",
  amberBg: "#f6efdb",
  amberLine: "#e0cf98",
  green: "#41745b",
  greenBg: "#e7f0e8",
  greenLine: "#bdd8be",
};

const dark: Palette = {
  canvas: "#0e1116",
  surface: "#171b21",
  card: "#1b2027",
  ink: "#f3f5f7",
  text: "#e6e9ee",
  muted: "#9aa1a9",
  faint: "#697079",
  line: "#232830",
  line2: "#2e343d",
  blue: "#8bbddd",
  blueInk: "#8bbddd",
  blueBg: "#14212c",
  blueLine: "#24384a",
  amber: "#dda664",
  amberBg: "#2a2113",
  amberLine: "#4a3a1e",
  green: "#88bc9b",
  greenBg: "#132218",
  greenLine: "#243a2c",
};

/** The palette for a colour scheme. Dark and light carry the SAME keys (checked in tests). */
export function resolveTheme(scheme: ColorScheme): Palette {
  return scheme === "dark" ? dark : light;
}

/** Corner radii, matched to the kit (chip/control 6–8, card 11, window 14). */
export const radii = { sm: 6, md: 8, lg: 11, xl: 14 } as const;

/** Spacing scale in points. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;

/** Type scale (points) and weights, from the kit's ftitle/fsub/chip/pill ramp. */
export const type = {
  title: 23,
  heading: 18,
  body: 15,
  control: 13.5,
  chip: 12,
  pill: 11,
  // React Native font weights are the hundreds ladder; the kit's 550/650 map to 500/600.
  weightRegular: "400",
  weightMedium: "500",
  weightSemibold: "600",
} as const;

/** The system sans stack (chrome is sans — no monospace as UI, per the kit). */
export const fontFamily = {
  sans: undefined, // RN default system font (San Francisco / Roboto) — no bundled face in M1.
  code: undefined,
} as const;

export { dark as darkPalette, light as lightPalette };
