// ─────────────────────────────────────────────────────────────────────────────
// The line tokenizer (issue #68), now backed by Shiki. Given one line of code and
// a language, it returns a flat list of typed tokens that the CodeView paints as
// coloured spans UNDER the diff row's add/removed background (the diff semantic
// stays dominant; see index.css). Shiki supplies the TOKENS ONLY — the CodeView
// still owns the row registry, mark placement, and the DOM.
//
// It stays SYNCHRONOUS and line-local: a fine-grained Shiki core highlighter, the
// pure-JS regex engine, and the nine grammars we support are wired at module load,
// so `tokenizeLine` returns immediately with no async grammar fetch and no flash of
// unhighlighted code (renderToStaticMarkup runs no effects — the tokens must exist
// on the first synchronous render). Each diff row is tokenized on its own, with no
// cross-line block-comment / template-string state (windowing means a row has no
// guaranteed neighbours). A line that is the interior of a block comment is
// highlighted as code — honest, bounded, and correct for the common case.
//
// It runs only on the WINDOWED rows the CodeView actually paints (never the whole
// file), so the R16 node-count / perf envelope is preserved: a scroll re-tokenizes
// at most a viewport of short lines. Pathological lines degrade gracefully to a
// single plain token rather than blocking the render.
// ─────────────────────────────────────────────────────────────────────────────

import shellLang from "@shikijs/langs/bash";
import cssLang from "@shikijs/langs/css";
import htmlLang from "@shikijs/langs/html";
import javascriptLang from "@shikijs/langs/javascript";
import jsonLang from "@shikijs/langs/json";
import markdownLang from "@shikijs/langs/markdown";
import pythonLang from "@shikijs/langs/python";
import typescriptLang from "@shikijs/langs/typescript";
import yamlLang from "@shikijs/langs/yaml";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** A token's semantic class. Everything the central CSS in index.css can style. */
export type TokenType =
  | "plain"
  | "keyword"
  | "type"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "property"
  | "variable"
  | "operator"
  | "punctuation";

export interface Token {
  readonly text: string;
  readonly type: TokenType;
}

export type LanguageId =
  | "typescript"
  | "javascript"
  | "json"
  | "css"
  | "python"
  | "shell"
  | "markdown"
  | "yaml"
  | "html";

/**
 * Lines longer than this are not tokenized (rendered as one plain token). A
 * minified bundle or a data blob has no useful token structure and would only
 * spend the node budget — graceful degradation, never a blocked render.
 */
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000;

/**
 * Lines that tokenize into more than this many tokens render as one plain token.
 * Every token becomes a DOM span, and the CodeView's R16 envelope budgets only a
 * few nodes per row; a pathological dense line (minified-ish, or long runs of
 * alternating single-char tokens) can produce hundreds of spans and blow that
 * budget even though it is under the length cap. Such a line has no useful token
 * structure, so it degrades to plain — the same graceful-degradation contract as
 * the length cap, keyed on the real cost driver (token/node count).
 */
export const MAX_HIGHLIGHT_LINE_TOKENS = 128;

// Our LanguageId → Shiki's registered grammar name. Shell rides the shellscript
// grammar (aliases bash/sh/zsh); every other id is 1:1.
const SHIKI_LANG: Readonly<Record<LanguageId, string>> = {
  typescript: "typescript",
  javascript: "javascript",
  json: "json",
  css: "css",
  python: "python",
  shell: "shellscript",
  markdown: "markdown",
  yaml: "yaml",
  html: "html",
};

// The tokenizer maps TextMate scopes to our TokenTypes through Shiki's own theme
// engine: each type is a "sentinel colour" — the type name itself — assigned to the
// scopes that carry it. Shiki resolves the scope→colour with real TextMate
// specificity (a quoted JSON key's `support.type.property-name.json` beats the
// generic `support.type`), splits the line at colour boundaries, and merges adjacent
// same-colour runs — so `token.color` is the TokenType and we never touch scopes by
// hand. `includeExplanation` is deliberately NOT used: with the pure-JS engine it
// throws on some inputs, and we need none of it. No real colour is emitted here — the
// CodeView paints tokens through the `.rtok-*` classes (which resolve to the
// @rennet/theme `--rn-syn-*` tokens, light + dark), so this module names no hue.
const TOKEN_TYPES: ReadonlySet<TokenType> = new Set<TokenType>([
  "plain",
  "keyword",
  "type",
  "string",
  "comment",
  "number",
  "function",
  "property",
  "variable",
  "operator",
  "punctuation",
]);

// Scope groups per TokenType. Restraint matches the old hand-rolled tokenizer:
// ordinary identifiers (variable.other.readwrite/constant/object) get no rule, so
// they fall through to the `plain` default and stay uncoloured but symbol-clickable.
const TYPE_SCOPES: readonly { readonly type: TokenType; readonly scopes: readonly string[] }[] = [
  { type: "comment", scopes: ["comment", "punctuation.definition.comment"] },
  {
    type: "string",
    scopes: [
      "string",
      "punctuation.definition.string",
      "constant.character",
      // A quoted JSON key is a string, never a clickable property.
      "support.type.property-name.json",
    ],
  },
  { type: "property", scopes: ["support.type.property-name", "entity.other.attribute-name"] },
  { type: "number", scopes: ["constant.numeric"] },
  { type: "keyword", scopes: ["keyword", "storage", "constant.language", "variable.language"] },
  { type: "operator", scopes: ["keyword.operator"] },
  { type: "function", scopes: ["entity.name.function", "support.function"] },
  {
    type: "type",
    scopes: [
      "entity.name.type",
      "entity.name.class",
      "entity.other.inherited-class",
      "support.type",
      "support.class",
      "entity.name.tag",
    ],
  },
  // Shell `$VAR` (variable.other.normal.shell); ordinary TS/JS identifiers use
  // variable.other.readwrite/constant/object and stay plain.
  { type: "variable", scopes: ["variable.other.normal"] },
  { type: "punctuation", scopes: ["punctuation"] },
];

const SCOPE_THEME = {
  name: "rennet-scopes",
  // The default (scope-less) rule paints everything `plain`; each group overrides its
  // scopes with the sentinel colour = its TokenType name.
  settings: [
    { settings: { foreground: "plain", background: "plain" } },
    ...TYPE_SCOPES.map((group) => ({
      scope: [...group.scopes],
      settings: { foreground: group.type },
    })),
  ],
};

const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  themes: [SCOPE_THEME],
  langs: [
    typescriptLang,
    javascriptLang,
    jsonLang,
    cssLang,
    pythonLang,
    shellLang,
    markdownLang,
    yamlLang,
    htmlLang,
  ],
});

function colorToType(color: string | undefined): TokenType {
  return color !== undefined && TOKEN_TYPES.has(color as TokenType)
    ? (color as TokenType)
    : "plain";
}

// Fail-closed number check (issue #92). shiki 4.4.3 scopes some MALFORMED numeric
// literals as `constant.numeric` — a trailing/leading/doubled `_` separator
// (`0b10_`, `1_`, `1__0`, `1e10_`) or a radix prefix with out-of-range digits
// (`0b102`, `0o18`) — where the old bespoke scanner failed them CLOSED to plain.
// Rather than re-implement the deleted scanner, we validate a `number` token's text
// against the canonical JS numeric-literal grammar and reclassify anything that does
// not match to `plain`. Each digit group is `<digit>(_?<digit>)*`, which structurally
// forbids a leading, trailing, or doubled separator; the radix groups forbid an
// out-of-range digit. Valid literals (`0b101`, `0xFF`, `1_000`, `1e10`, `1.5`, `.5`,
// `5.`) still pass and stay `number`.
const HEX_DIGITS = "[0-9a-fA-F](?:_?[0-9a-fA-F])*";
const BIN_DIGITS = "[01](?:_?[01])*";
const OCT_DIGITS = "[0-7](?:_?[0-7])*";
const DEC_DIGITS = "[0-9](?:_?[0-9])*";
const NUMERIC_LITERAL = new RegExp(
  "^(?:" +
    `0[xX]${HEX_DIGITS}n?` +
    `|0[bB]${BIN_DIGITS}n?` +
    `|0[oO]${OCT_DIGITS}n?` +
    // Decimal: int / float / leading-dot / trailing-dot, optional exponent, optional bigint.
    `|(?:${DEC_DIGITS}\\.${DEC_DIGITS}?|\\.${DEC_DIGITS}|${DEC_DIGITS})(?:[eE][+-]?${DEC_DIGITS})?n?` +
    ")$",
);

function isValidNumericLiteral(text: string): boolean {
  return NUMERIC_LITERAL.test(text);
}

// Tokenize a single line with Shiki, reading each run's sentinel colour as its
// TokenType and merging adjacent same-type runs so the line does not explode into
// per-char spans (keeps the CodeView inside the R16 node budget).
function highlightLine(code: string, languageId: LanguageId): Token[] {
  const { tokens } = highlighter.codeToTokens(code, {
    lang: SHIKI_LANG[languageId],
    theme: SCOPE_THEME.name,
  });
  const out: Token[] = [];
  for (const line of tokens) {
    for (const token of line) {
      if (token.content.length === 0) continue;
      const classified = colorToType(token.color);
      // Fail a malformed numeric literal CLOSED to plain (#92) before the merge, so
      // it coalesces with any adjacent plain run.
      const type =
        classified === "number" && !isValidNumericLiteral(token.content) ? "plain" : classified;
      const last = out[out.length - 1];
      if (last !== undefined && last.type === type) {
        out[out.length - 1] = { text: last.text + token.content, type };
      } else {
        out.push({ text: token.content, type });
      }
    }
  }
  return out;
}

/**
 * Tokenize one line of code for `languageId`. An unknown/absent language, or a
 * line past the length cap, returns a single plain token — fail-closed, never a
 * crash and never fabricated colouring.
 */
export function tokenizeLine(code: string, languageId: LanguageId | null): Token[] {
  if (code.length === 0) return [];
  if (languageId === null) return [{ text: code, type: "plain" }];
  if (code.length > MAX_HIGHLIGHT_LINE_LENGTH) return [{ text: code, type: "plain" }];
  const tokens = highlightLine(code, languageId);
  // A line that shatters into more spans than the row-node budget can hold has no
  // useful token structure — degrade it to plain rather than blow the R16 envelope.
  if (tokens.length > MAX_HIGHLIGHT_LINE_TOKENS) return [{ text: code, type: "plain" }];
  return tokens;
}

/** Tokenize diff source with its one-character marker outside the language grammar. */
export function tokenizeDiffLine(code: string, languageId: LanguageId | null): Token[] {
  if (languageId === null || !["+", "-", " "].includes(code.charAt(0))) {
    return tokenizeLine(code, languageId);
  }
  const source = tokenizeLine(code.slice(1), languageId);
  if (source.length === 1 && source[0]?.type === "plain") {
    return [{ text: code, type: "plain" }];
  }
  return [{ text: code.charAt(0), type: "plain" }, ...source];
}

const EXT_TO_LANG: Readonly<Record<string, LanguageId>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "css",
  less: "css",
  py: "python",
  pyi: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  svelte: "html",
};

/**
 * The language for a file path, by extension. Fail-closed: an unknown or missing
 * extension (including dotfiles like `.zshrc`) returns null — the caller renders
 * plain text, never fabricated colouring.
 */
export function detectLanguage(path: string): LanguageId | null {
  const cleaned = path.split(/[?#]/, 1)[0] ?? path;
  const slash = cleaned.lastIndexOf("/");
  const base = slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
  const dot = base.lastIndexOf(".");
  // dot <= 0 covers both "no extension" and a leading-dot dotfile (`.zshrc`).
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}
