import type {
  SymbolInspection,
  SymbolInspectorDefinitionRow,
  SymbolInspectorReferenceRow,
  SymbolInspectorSection,
  SymbolNeighbor,
  SymbolNeighbors,
  SymbolTier,
} from "@rennet/types";
import type { TokenType } from "../syntax/languages";

// ─────────────────────────────────────────────────────────────────────────────
// The in-app symbol inspector (Rai, wireframes #8).
//
// Rai's steer: an inline definition rendered into the code is "proper weird". The
// nicer UX is to click a symbol in the diff and get an IN-APP preview/inspector —
// where it is defined, where it is used (blast radius), and a way to open it in the
// editor. The data source is Rennet's OWN model-free symbolic surface
// (`context.symbol` / `context.references`), so this is honest go-to-definition and
// find-references, never an LLM guess.
//
// This module holds the host-free pieces the inspector renders from: which code
// tokens are clickable symbols, the result shape the lookup port returns (a mirror
// of the symbolic surface's answers, gated so an unavailable snapshot is a first-
// class state and never a silent blank), and the pure grouping the references list
// displays. Kept in `@rennet/ui` (types only), so every rule here is unit-testable
// without a DOM.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token classes whose TEXT can never be a clickable symbol: keywords, string/comment
 * literals, numbers, operators, punctuation. Everything else (`plain`, `function`,
 * `type`, `variable`, `property`) may carry an identifier worth inspecting.
 *
 * Clickability must NOT key off the highlight class alone: the tokenizer classifies
 * an ordinary identifier (`count`, `result`, `value`) as `plain`, and merges a
 * leading-whitespace run into the following `plain` token — so a class-only check
 * misses the common case entirely. Instead a symbol-bearing token's text is split
 * into identifier runs, and only those runs become clickable.
 */
const NON_SYMBOL_TOKENS: ReadonlySet<TokenType> = new Set<TokenType>([
  "keyword",
  "string",
  "comment",
  "number",
  "operator",
  "punctuation",
]);

/** Whether a token's CLASS may contain a clickable identifier (i.e. is not inert chrome). */
export function tokenMayContainSymbol(type: TokenType): boolean {
  return !NON_SYMBOL_TOKENS.has(type);
}

/** The string delimiters a quoted key can open with. */
const STRING_DELIMITERS: ReadonlySet<string> = new Set(['"', "'", "`"]);

/**
 * Whether a token, given its class AND text, may carry a clickable identifier.
 * Beyond the class check, this excludes a QUOTED property key — the tokenizer
 * classifies a string in key position (`"name":` in JSON/YAML/CSS) as `property`,
 * and its text keeps the quotes, so splitting out `name` would render a DEAD
 * clickable button inside a string. A quoted property is a string, not a symbol.
 */
export function tokenTextMayContainSymbol(type: TokenType, text: string): boolean {
  if (!tokenMayContainSymbol(type)) return false;
  if (type === "property" && text.length > 0 && STRING_DELIMITERS.has(text.charAt(0))) return false;
  return true;
}

/** One segment of a token's text: an identifier run (clickable) or the gap around it. */
export interface TokenSegment {
  readonly text: string;
  readonly isIdentifier: boolean;
}

// A JS/TS identifier run. Deliberately independent of the highlighter's word
// classification so a `plain` identifier (or several separated by whitespace inside
// one merged token) each become their own clickable run.
const IDENTIFIER_RUN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Split a token's text into identifier runs and the gaps between them, in order,
 * covering the whole string. `"  count"` → `[gap "  ", ident "count"]`;
 * `"foo bar"` → `[ident "foo", gap " ", ident "bar"]`; `"doThing"` → `[ident]`.
 * Pure; a text with no identifier is a single gap segment.
 */
export function splitIdentifierRuns(text: string): TokenSegment[] {
  const segments: TokenSegment[] = [];
  let last = 0;
  IDENTIFIER_RUN.lastIndex = 0;
  for (let match = IDENTIFIER_RUN.exec(text); match !== null; match = IDENTIFIER_RUN.exec(text)) {
    if (match.index > last)
      segments.push({ text: text.slice(last, match.index), isIdentifier: false });
    segments.push({ text: match[0], isIdentifier: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), isIdentifier: false });
  return segments;
}

// The lookup answer shapes are shared with the protocol command
// (`review.symbolLookup`) and so live in `@rennet/types`; aliased here under the
// names the inspector + helpers use.
export type SymbolDefinitionRow = SymbolInspectorDefinitionRow;
export type SymbolReferenceRow = SymbolInspectorReferenceRow;
export type SymbolLookupSection<Row> = SymbolInspectorSection<Row>;
export type { SymbolInspection, SymbolNeighbor, SymbolNeighbors, SymbolTier };

/** The port the inspector calls: resolve one name to its definitions + references. */
export type SymbolLookupPort = (name: string) => Promise<SymbolInspection>;

/** A file's grouped reference lines, for the compact references list. */
export interface ReferenceGroup {
  readonly path: string;
  /** The 1-based occurrence lines in this file, ascending and de-duplicated. */
  readonly lines: readonly number[];
}

/**
 * Group reference sites by file for display, each file's lines ascending and
 * de-duplicated, and the files ordered by path. Pure — the inspector renders
 * whatever this returns. (The sites already arrive ranked by (path, line); this
 * regroups them into one row per file so a symbol used many times in one file reads
 * as one entry, not a wall.)
 */
export function groupReferencesByFile(
  sites: readonly SymbolReferenceRow[],
): readonly ReferenceGroup[] {
  const byPath = new Map<string, Set<number>>();
  for (const site of sites) {
    const lines = byPath.get(site.path) ?? new Set<number>();
    lines.add(site.line);
    byPath.set(site.path, lines);
  }
  return [...byPath.entries()]
    .map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The last path segment, for a compact filename label (the full path stays the tooltip). */
export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
