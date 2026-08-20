// ─────────────────────────────────────────────────────────────────────────────
// Syntax grammars + language detection (issue #68).
//
// This is a small, OWNED, deterministic tokenizer — NOT a dependency. The
// Dependency Standard reserves diff-surface highlighting for @pierre/diffs
// ("Pierre owns syntax highlighting, so do not add direct Shiki"), but Pierre is
// DEFERRED ("MUST after rerun") and the current CodeView is a hand-rolled windowed
// renderer that Pierre never touches. Adding Shiki/Prism/tree-sitter here would be
// a heavy parallel highlighter that conflicts with Pierre when it lands; a ~1-file
// owned regex-free tokenizer is the "OWN" verdict — small load-bearing product
// logic, zero runtime deps, synchronous, deterministic, fail-closed. When
// @pierre/diffs is adopted it replaces this whole CodeView, and Pierre's
// highlighting supersedes this module; it is deliberately confined to `syntax/`
// so removing it is a single integration change.
//
// The grammars are intentionally line-local: each diff row is tokenized on its
// own, with no cross-line block-comment / template-string state (windowing means a
// row has no guaranteed neighbours). A line that is the interior of a block
// comment is highlighted as code. Honest, bounded, and correct for the common
// case; stateful per-hunk tokenization is a follow-up.
// ─────────────────────────────────────────────────────────────────────────────

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

export interface StringDelim {
  readonly open: string;
  readonly close: string;
  /** The escape char that neutralises the next char inside the string, or null. */
  readonly escape: string | null;
}

export interface Grammar {
  /** Line-comment markers, e.g. ["//"], ["#"]. Longest-first for correct matching. */
  readonly lineComments: readonly string[];
  /**
   * When true, a line-comment marker only opens a comment at line start or after
   * whitespace — so shell `echo foo#bar` and a YAML `#frag` inside a URL are NOT
   * comments, while `echo foo #bar` is. Python leaves this false: `x=1#c` is a
   * comment even glued to the preceding token.
   */
  readonly commentNeedsWordBoundary: boolean;
  /** Block-comment delimiters (line-local only), open+close pair, or null. */
  readonly blockComment: readonly [string, string] | null;
  readonly strings: readonly StringDelim[];
  readonly keywords: ReadonlySet<string>;
  /** Rendered as `type` (primitive/builtin type names). */
  readonly types: ReadonlySet<string>;
  /** A non-keyword identifier directly before `(` is a function call. */
  readonly functionCall: boolean;
  /** An Uppercase-initial identifier is a type (class/component/type name). */
  readonly capitalizedTypes: boolean;
  /** This sigil + an identifier is a variable reference, e.g. `$` in shell. */
  readonly variableSigil: string | null;
  /** An identifier/string directly before `:` is a property (JSON/YAML/CSS keys). */
  readonly propertyBeforeColon: boolean;
  /** Whether numeric literals are recognised (off for prose-ish langs). */
  readonly numbers: boolean;
}

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

const TS_KEYWORDS = words(`
  abstract any as asserts async await break case catch class const continue debugger
  declare default delete do else enum export extends false finally for from function
  get if implements import in infer instanceof interface is keyof let namespace never
  new null of override package private protected public readonly return satisfies set
  static super switch symbol this throw true try type typeof undefined unique unknown
  var void while with yield as const
`);

const TS_TYPES = words(`
  string number boolean object symbol bigint any unknown never void undefined null
  Array Promise Record Partial Readonly Required Pick Omit Map Set WeakMap WeakSet
  Date RegExp Error ReadonlyArray ReturnType Parameters Awaited NonNullable
`);

const PYTHON_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except finally for
  from global if import in is lambda nonlocal not or pass raise return try while with
  yield True False None self cls match case
`);

const PYTHON_TYPES = words(`
  int float str bool bytes list dict set tuple frozenset object type complex bytearray
  None Any Optional Union List Dict Set Tuple Callable Iterator Iterable Sequence
`);

const SHELL_KEYWORDS = words(`
  if then elif else fi for while until do done case esac function in select time
  return break continue local export readonly declare set unset source alias eval exit
  echo cd test
`);

const CSS_AT = words(`
  media supports keyframes import font-face charset namespace page layer container
  property scope starting-style
`);

const YAML_KEYWORDS = words(`true false null yes no on off ~`);

const JSON_KEYWORDS = words(`true false null`);

const HTML_KEYWORDS: ReadonlySet<string> = new Set();

const NONE: ReadonlySet<string> = new Set();

const DQUOTE: StringDelim = { open: '"', close: '"', escape: "\\" };
const SQUOTE: StringDelim = { open: "'", close: "'", escape: "\\" };
const BACKTICK: StringDelim = { open: "`", close: "`", escape: "\\" };

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

const TS_GRAMMAR: Grammar = {
  lineComments: ["//"],
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  strings: [DQUOTE, SQUOTE, BACKTICK],
  keywords: TS_KEYWORDS,
  types: TS_TYPES,
  functionCall: true,
  capitalizedTypes: true,
  variableSigil: null,
  propertyBeforeColon: false,
  numbers: true,
};

const JSON_GRAMMAR: Grammar = {
  lineComments: ["//"],
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  strings: [DQUOTE],
  keywords: JSON_KEYWORDS,
  types: NONE,
  functionCall: false,
  capitalizedTypes: false,
  variableSigil: null,
  propertyBeforeColon: true,
  numbers: true,
};

const CSS_GRAMMAR: Grammar = {
  lineComments: [],
  commentNeedsWordBoundary: false,
  blockComment: ["/*", "*/"],
  strings: [DQUOTE, SQUOTE],
  keywords: CSS_AT,
  types: NONE,
  functionCall: true,
  capitalizedTypes: false,
  variableSigil: null,
  propertyBeforeColon: true,
  numbers: true,
};

const PYTHON_GRAMMAR: Grammar = {
  lineComments: ["#"],
  commentNeedsWordBoundary: false,
  blockComment: null,
  strings: [DQUOTE, SQUOTE],
  keywords: PYTHON_KEYWORDS,
  types: PYTHON_TYPES,
  functionCall: true,
  capitalizedTypes: true,
  variableSigil: null,
  propertyBeforeColon: false,
  numbers: true,
};

const SHELL_GRAMMAR: Grammar = {
  lineComments: ["#"],
  commentNeedsWordBoundary: true,
  blockComment: null,
  strings: [DQUOTE, SQUOTE],
  keywords: SHELL_KEYWORDS,
  types: NONE,
  functionCall: false,
  capitalizedTypes: false,
  variableSigil: "$",
  propertyBeforeColon: false,
  numbers: true,
};

const YAML_GRAMMAR: Grammar = {
  lineComments: ["#"],
  commentNeedsWordBoundary: true,
  blockComment: null,
  strings: [DQUOTE, SQUOTE],
  keywords: YAML_KEYWORDS,
  types: NONE,
  functionCall: false,
  capitalizedTypes: false,
  variableSigil: null,
  propertyBeforeColon: true,
  numbers: true,
};

const MARKDOWN_GRAMMAR: Grammar = {
  lineComments: [],
  commentNeedsWordBoundary: false,
  blockComment: null,
  strings: [BACKTICK],
  keywords: NONE,
  types: NONE,
  functionCall: false,
  capitalizedTypes: false,
  variableSigil: null,
  propertyBeforeColon: false,
  numbers: false,
};

const HTML_GRAMMAR: Grammar = {
  lineComments: [],
  commentNeedsWordBoundary: false,
  blockComment: ["<!--", "-->"],
  strings: [DQUOTE, SQUOTE],
  keywords: HTML_KEYWORDS,
  types: NONE,
  functionCall: false,
  capitalizedTypes: false,
  variableSigil: null,
  propertyBeforeColon: false,
  numbers: false,
};

export const GRAMMARS: Readonly<Record<LanguageId, Grammar>> = {
  typescript: TS_GRAMMAR,
  javascript: TS_GRAMMAR,
  json: JSON_GRAMMAR,
  css: CSS_GRAMMAR,
  python: PYTHON_GRAMMAR,
  shell: SHELL_GRAMMAR,
  yaml: YAML_GRAMMAR,
  markdown: MARKDOWN_GRAMMAR,
  html: HTML_GRAMMAR,
};

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
