import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type CodeThemeId, DEFAULT_CODE_THEME } from "./assets/code-theme";
import { DEFAULT_THEME_PACK, type ThemePackId } from "./assets/theme-packs";

// ─────────────────────────────────────────────────────────────────────────────
// App-global theme preference (C10 §6.2–6.3, claims 631–635). The UI theme pack
// and the code theme are CLIENT prefs with NO protocol command (B10-absent) and NO
// place in the honest-empty `SettingsProjection` (which is empty in the live client,
// so routing a live-applying preference through it would make the picker inert). They
// live HERE: genuine app-global React state that stamps `data-rn-theme` /
// `data-rn-code-theme` on the document root, and the CSS packs wired into
// `@rennet/theme/theme.css` re-bind every --rn-* token the moment the attribute
// changes — live, no reload, no JS re-highlight (the diff/code `.rtok-*` spans read
// `--rn-syn-*`, so a code-theme swap recolours them with zero JavaScript).
//
// The default pack (Affineur's Bench) is the base palette.css, reached by CLEARING
// `data-rn-theme`; the default code theme ("rennet" = follow theme) clears
// `data-rn-code-theme`. Cross-session persistence to `client-settings.json` is the
// B10 fold (cluster 10) — this provider is the only file that binds at that point;
// until then the choice is live for the session, exactly as the rest of C10 is
// MemoryBridge-first with no real file write in a page body.
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemePref {
  readonly themePack: ThemePackId;
  readonly codeTheme: CodeThemeId;
  setThemePack(id: ThemePackId): void;
  setCodeTheme(id: CodeThemeId): void;
}

const ThemePrefContext = createContext<ThemePref>({
  themePack: DEFAULT_THEME_PACK,
  codeTheme: DEFAULT_CODE_THEME,
  setThemePack: () => undefined,
  setCodeTheme: () => undefined,
});

/** The one hook the Appearance page reads/writes the app-global theme pref through. */
export function useThemePref(): ThemePref {
  return useContext(ThemePrefContext);
}

/**
 * Mounts the app-global theme-pref state and stamps the document root live. Wraps the
 * whole app (see `routes/app.tsx`) so any code surface re-highlights when the code
 * theme changes and every surface re-binds when the pack changes.
 */
export function ThemePrefProvider({
  children,
  initialThemePack = DEFAULT_THEME_PACK,
  initialCodeTheme = DEFAULT_CODE_THEME,
}: {
  readonly children: ReactNode;
  readonly initialThemePack?: ThemePackId;
  readonly initialCodeTheme?: CodeThemeId;
}) {
  const [themePack, setThemePack] = useState<ThemePackId>(initialThemePack);
  const [codeTheme, setCodeTheme] = useState<CodeThemeId>(initialCodeTheme);

  // The pack stamps `data-rn-theme`; the DEFAULT pack clears it (base palette.css).
  useEffect(() => {
    const root = document.documentElement;
    if (themePack === DEFAULT_THEME_PACK) root.removeAttribute("data-rn-theme");
    else root.dataset.rnTheme = themePack;
  }, [themePack]);

  // The code theme stamps `data-rn-code-theme`, INDEPENDENT of the pack; the default
  // "rennet" (follow theme) clears it, so code follows the active pack's own syntax.
  useEffect(() => {
    const root = document.documentElement;
    if (codeTheme === DEFAULT_CODE_THEME) root.removeAttribute("data-rn-code-theme");
    else root.dataset.rnCodeTheme = codeTheme;
  }, [codeTheme]);

  const value = useMemo<ThemePref>(
    () => ({ themePack, codeTheme, setThemePack, setCodeTheme }),
    [themePack, codeTheme],
  );

  return <ThemePrefContext.Provider value={value}>{children}</ThemePrefContext.Provider>;
}
