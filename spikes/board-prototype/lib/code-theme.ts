/**
 * Code-view (shiki) themes — independent of the UI theme pack. "auto" follows
 * the interface scheme (github-light / github-dark); the rest are explicit and
 * scheme-independent. All ship in shiki's bundle.
 */
export type CodeThemeId =
  | "auto"
  | "github-light"
  | "github-dark"
  | "one-dark-pro"
  | "dracula"
  | "catppuccin-mocha"

export const CODE_THEMES: { id: CodeThemeId; label: string }[] = [
  { id: "auto", label: "Follow scheme" },
  { id: "github-light", label: "GitHub Light" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "dracula", label: "Dracula" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
]

/** Every concrete shiki theme the highlighter must preload. */
export const SHIKI_THEMES = [
  "github-light",
  "github-dark",
  "one-dark-pro",
  "dracula",
  "catppuccin-mocha",
] as const

/** Resolve the picker value to a concrete shiki theme for the current scheme. */
export function resolveCodeTheme(id: CodeThemeId, scheme: "light" | "dark"): string {
  if (id === "auto") return scheme === "dark" ? "github-dark" : "github-light"
  return id
}
