import { createCssVariablesTheme } from "shiki"

/** Shared name for the CSS-variables theme, referenced wherever `codeToTokens` is called. */
export const CODE_THEME_NAME = "rennet-code"

/**
 * A Shiki theme whose token colors are CSS custom properties instead of
 * hardcoded hex values. This lets one highlighter output work for both the
 * light and dark themes (and follow future theme changes) by defining the
 * `--shiki-*` variables in globals.css instead of baking in a fixed palette.
 */
export const codeTheme = createCssVariablesTheme({
  name: CODE_THEME_NAME,
  variablePrefix: "--shiki-",
  fontStyle: true,
})
