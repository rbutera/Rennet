// ─────────────────────────────────────────────────────────────────────────────
// Code themes (C10 §6.2, claims 631–634, issue #481 §4), ported from the spike's
// `code-theme.ts` and REBOUND to the real `@rennet/theme` code themes. The code
// theme is the SYNTAX axis only (`--rn-syn-*` + the code ground), INDEPENDENT of
// the UI theme pack: any pack runs with any code theme. Each concrete theme already
// swaps light/dark internally via `data-scheme`, so a code theme is one id, not a
// light/dark pair.
//
// The default `rennet` code theme is the ABSENCE of the attribute — code then
// follows the active pack's own `--rn-syn-*` (and thus the scheme). The concrete
// CSS lives in `packages/theme/src/code-themes/<id>.css`; this list is the picker's
// option registry, and the Appearance page stamps `data-rn-code-theme` live.
// ─────────────────────────────────────────────────────────────────────────────

export type CodeThemeId = "rennet" | "github" | "one-dark-pro" | "dracula" | "catppuccin-mocha";

export const CODE_THEMES: readonly { readonly id: CodeThemeId; readonly label: string }[] = [
  { id: "rennet", label: "Follow theme" },
  { id: "github", label: "GitHub" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "dracula", label: "Dracula" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
];

/** The default code theme — follows the active pack, reached by clearing the attribute. */
export const DEFAULT_CODE_THEME: CodeThemeId = "rennet";
