import type {
  SymbolInspection,
  SymbolInspectorDefinitionRow,
  SymbolInspectorReferenceRow,
  SymbolInspectorSection,
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
 * The token classes that name a symbol worth inspecting: a function, a type, a
 * variable, or a property identifier. Keywords, strings, comments, numbers,
 * operators and punctuation are inert chrome — clicking them would resolve nothing.
 */
const CLICKABLE_SYMBOL_TOKENS: ReadonlySet<TokenType> = new Set<TokenType>([
  "function",
  "type",
  "variable",
  "property",
]);

/** Whether a syntax token is a clickable symbol (a function/type/variable/property identifier). */
export function isClickableSymbolToken(type: TokenType): boolean {
  return CLICKABLE_SYMBOL_TOKENS.has(type);
}

// The lookup answer shapes are shared with the protocol command
// (`review.symbolLookup`) and so live in `@rennet/types`; aliased here under the
// names the inspector + helpers use.
export type SymbolDefinitionRow = SymbolInspectorDefinitionRow;
export type SymbolReferenceRow = SymbolInspectorReferenceRow;
export type SymbolLookupSection<Row> = SymbolInspectorSection<Row>;
export type { SymbolInspection };

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
