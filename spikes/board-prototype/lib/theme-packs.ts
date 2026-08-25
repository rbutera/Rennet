/**
 * UI theme packs (issue #481). A pack = a complete scoped re-binding of the
 * --rn-* tokens under [data-rn-theme="<id>"] in globals.css, both scheme
 * blocks, semantic roles preserved. "affineur" is the default (no attribute —
 * base globals.css applies). AppearanceSync stamps data-rn-theme for the rest.
 *
 * The pack CSS in globals.css is hand-rolled from the well-known upstream
 * palettes (prototype, zero rigor) — it gets replaced by copies of the real
 * packs from packages/theme/src/themes/ once that agent lands them.
 */
export type ThemePackId = "affineur" | "github" | "one-dark-pro" | "dracula" | "catppuccin-mocha"

export const THEME_PACKS: { id: ThemePackId; label: string }[] = [
  { id: "affineur", label: "Affineur's Bench" },
  { id: "github", label: "GitHub" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "dracula", label: "Dracula" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
]
