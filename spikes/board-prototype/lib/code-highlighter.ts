import { createHighlighter, type Highlighter, type ThemedToken, type BundledLanguage } from "shiki"
import { codeTheme, CODE_THEME_NAME } from "./code-theme"

let highlighterPromise: Promise<Highlighter> | null = null

/** Loads (once) and reuses a single Shiki highlighter instance for the whole app. */
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [codeTheme],
      langs: ["typescript", "tsx", "javascript", "jsx", "json", "bash", "css", "sql"],
    })
  }
  return highlighterPromise
}

/**
 * Tokenizes `code` into per-line, per-token color info using the shared
 * CSS-variable theme. Loads additional languages on demand.
 */
export async function getHighlightedLines(code: string, lang: string): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter()

  if (!highlighter.getLoadedLanguages().includes(lang)) {
    try {
      await highlighter.loadLanguage(lang as BundledLanguage)
    } catch {
      // Unknown language — fall back to plain text tokenization below.
    }
  }

  const knownLang = highlighter.getLoadedLanguages().includes(lang) ? lang : "text"
  const { tokens } = highlighter.codeToTokens(code, { lang: knownLang as BundledLanguage, theme: CODE_THEME_NAME })
  return tokens
}
