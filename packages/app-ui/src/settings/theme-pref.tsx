import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMutation } from "../data/mutate";
import { useCommand } from "../data/query";
import { type CodeThemeId, DEFAULT_CODE_THEME } from "./assets/code-theme";
import { DEFAULT_THEME_PACK, type ThemePackId } from "./assets/theme-packs";

// ─────────────────────────────────────────────────────────────────────────────
// App-global theme preference (C10 §6.2–6.3, claims 631–635). The UI theme pack
// persists through client settings while code theme remains a session preference. Both
// live-apply HERE through app-global React state that stamps `data-rn-theme` /
// `data-rn-code-theme` on the document root, and the CSS packs wired into
// `@rennet/theme/theme.css` re-bind every --rn-* token the moment the attribute
// changes — live, no reload, no JS re-highlight (the diff/code `.rtok-*` spans read
// `--rn-syn-*`, so a code-theme swap recolours them with zero JavaScript).
//
// The default pack (Affineur's Bench) is the base palette.css, reached by CLEARING
// `data-rn-theme`; the default code theme ("rennet" = follow theme) clears
// `data-rn-code-theme`. Theme-pack writes optimistically apply and roll back if the
// persisted client-settings write fails.
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemePref {
  readonly themePack: ThemePackId;
  readonly codeTheme: CodeThemeId;
  setThemePack(id: ThemePackId): Promise<void>;
  setCodeTheme(id: CodeThemeId): void;
}

const ThemePrefContext = createContext<ThemePref>({
  themePack: DEFAULT_THEME_PACK,
  codeTheme: DEFAULT_CODE_THEME,
  setThemePack: async () => undefined,
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
  const { data: settings } = useCommand("settings.get", {});
  const { mutate: persistThemePack } = useMutation("settings.setThemePack", {
    invalidates: ["settings.get"],
  });
  const [themePack, setThemePackState] = useState<ThemePackId>(initialThemePack);
  const [codeTheme, setCodeTheme] = useState<CodeThemeId>(initialCodeTheme);

  useEffect(() => {
    if (settings?.themePack) setThemePackState(settings.themePack);
  }, [settings?.themePack]);

  const setThemePack = useCallback(
    async (id: ThemePackId): Promise<void> => {
      const previous = themePack;
      setThemePackState(id);
      try {
        await persistThemePack({ themePack: id });
      } catch (reason) {
        setThemePackState(previous);
        throw reason;
      }
    },
    [persistThemePack, themePack],
  );

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
    [themePack, codeTheme, setThemePack],
  );

  return <ThemePrefContext.Provider value={value}>{children}</ThemePrefContext.Provider>;
}
