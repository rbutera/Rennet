import { createHighlighter, type Highlighter, type ThemedToken, type BundledLanguage } from "shiki"
import { SHIKI_THEMES } from "./code-theme"

let highlighterPromise: Promise<Highlighter> | null = null

/** Loads (once) and reuses a single Shiki highlighter instance for the whole app. */
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...SHIKI_THEMES],
      langs: ["typescript", "tsx", "javascript", "jsx", "json", "bash", "css", "sql"],
    })
  }
  return highlighterPromise
}

/**
 * Tokenizes `code` into per-line, per-token color info under the given shiki
 * `theme` (a concrete theme name — resolve "auto" via resolveCodeTheme first).
 * Loads additional languages on demand.
 */
export async function getHighlightedLines(
  code: string,
  lang: string,
  theme: string,
): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter()

  if (!highlighter.getLoadedLanguages().includes(lang)) {
    try {
      await highlighter.loadLanguage(lang as BundledLanguage)
    } catch {
      // Unknown language — fall back to plain text tokenization below.
    }
  }

  const knownLang = highlighter.getLoadedLanguages().includes(lang) ? lang : "text"
  const { tokens } = highlighter.codeToTokens(code, { lang: knownLang as BundledLanguage, theme })
  return tokens
}
