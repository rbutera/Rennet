/**
 * Shared theme name, referenced wherever `codeToTokens` is called.
 *
 * Code highlighting stays a neutral bundled theme rather than the interface
 * palette. The prototype renders dark-only (layout hardcodes `.dark`), so one
 * dark theme suffices; add a light/dark pair if a scheme toggle ever lands.
 */
export const CODE_THEME_NAME = "github-dark"
