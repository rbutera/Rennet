// ─────────────────────────────────────────────────────────────────────────────
// UI theme packs (C10 §6.2, claims 631–634, issue #481), ported from the spike's
// `theme-packs.ts` and REBOUND to the real `@rennet/theme` packs. A pack is a
// COLOUR-only re-binding of the `--rn-*` tokens, scoped under `[data-rn-theme="<id>"]`
// in the theme package (both scheme blocks). "affineur" is the default — the base
// `palette.css`, stamped by CLEARING the attribute, never setting it.
//
// The concrete pack CSS lives in `packages/theme/src/themes/<id>.css`; this list is
// the picker's option registry. Live-applying: the Appearance page stamps
// `data-rn-theme` on the document root, and the browser re-binds every token.
// ─────────────────────────────────────────────────────────────────────────────

export type ThemePackId = "affineur" | "github" | "one-dark-pro" | "dracula" | "catppuccin-mocha";

export const THEME_PACKS: readonly { readonly id: ThemePackId; readonly label: string }[] = [
  { id: "affineur", label: "Affineur's Bench" },
  { id: "github", label: "GitHub" },
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "dracula", label: "Dracula" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
];

/** The default pack — the base `palette.css`, reached by clearing `data-rn-theme`. */
export const DEFAULT_THEME_PACK: ThemePackId = "affineur";
