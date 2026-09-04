import type {
  GrillContextMap,
  GrillContextRow,
  GrillDecision,
  GrillGlossaryTerm,
  GrillSpec,
} from "@rennet/protocol";

/**
 * Parse a grill-with-docs specification's markdown into a STRUCTURED model.
 *
 * grill-with-docs is the sparse, doc-driven spec format: architecture decision
 * records (`docs/adr/**`, `docs/decisions/**`) and a `CONTEXT.md` carrying a
 * glossary (a `## Language` section) and context-map tables. Unlike an OpenSpec
 * change, it ships no fixed artifact set and no requirement/scenario tree — a thin
 * ADR is a legitimate whole specification. This module is the parser that mirrors
 * `openspec-change.ts`: it is node-free (pure string work, no fs), so the reader is
 * a plain function of the document text and every rule is unit-testable.
 *
 * It is deliberately tolerant: any document may be absent, a section may be missing
 * or empty, and it never throws on well-formed-but-sparse input. Absence is
 * represented HONESTLY — a decision that states no alternatives carries an empty
 * array, a glossary entry with no stated `_Avoid_` carries an empty `avoid`, and a
 * source with nothing of a kind contributes nothing rather than an invented
 * placeholder. Nothing is inferred from the diff; the model says only what the
 * documents say.
 *
 * The extracted shapes match what `parseDesignSourceObligations`' grill branch reads
 * (`parseGrillAdr`, `parseGrillGlossary` in `board/design-obligations.ts`): a
 * decision's verbatim title, rationale, and considered options; a glossary term's
 * definition and words to avoid, grouped. Context-map tables are additive — the
 * surface renders each row's cells as `source_cells`.
 */

/** One grill document read off disk: its repo-relative path and raw markdown. */
export interface GrillDoc {
  readonly path: string;
  readonly md: string;
}

/** The raw document text for one grill-with-docs specification (what an adapter reads). */
export interface GrillSpecSource {
  /** Architecture decision records (`docs/adr/**`, `docs/decisions/**`). */
  readonly adrs?: readonly GrillDoc[];
  /** `CONTEXT.md` documents carrying a glossary and/or context-map tables. */
  readonly contextDocs?: readonly GrillDoc[];
}

/** Split into lines, tolerating CRLF, with no trailing carriage returns. */
function toLines(md: string): string[] {
  return md.replace(/\r\n?/g, "\n").split("\n");
}

/** Collapse internal whitespace to single spaces and trim — the verbatim words, one line. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Blank out fenced code blocks so headings and tables inside a fence are never
 * mistaken for structure (mirrors `design-obligations.ts`' `visibleMarkdownLines`).
 * Real content outside fences is preserved intact.
 */
function visibleLines(lines: readonly string[]): string[] {
  let fenceMarker: string | undefined;
  return lines.map((line) => {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMarker === undefined && opening !== undefined) {
      fenceMarker = opening;
      return "";
    }
    if (fenceMarker !== undefined) {
      if (line.trimStart().startsWith(fenceMarker)) fenceMarker = undefined;
      return "";
    }
    return line;
  });
}

/** A heading match: its level (number of `#`), trimmed text, and 0-based line index. */
interface Heading {
  readonly level: number;
  readonly title: string;
  readonly index: number;
}

function findHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(lines[index] ?? "");
    const hashes = match?.[1];
    const title = match?.[2];
    if (hashes === undefined || title === undefined) continue;
    headings.push({ level: hashes.length, title: title.trim(), index });
  }
  return headings;
}

/** The 0-based line where a heading's section ends: the next heading of level ≤ its own. */
function sectionEnd(
  lines: readonly string[],
  headings: readonly Heading[],
  heading: Heading,
): number {
  return (
    headings.find(
      (candidate) => candidate.index > heading.index && candidate.level <= heading.level,
    )?.index ?? lines.length
  );
}

/** Prose between two line indices, dropping headings, horizontal rules, and blanks. */
function textBetween(lines: readonly string[], start: number, end: number): string {
  return normalizeText(
    lines
      .slice(start, end)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed.length > 0 && !/^#{1,6}\s+/.test(trimmed) && !/^([-*_])\1{2,}$/.test(trimmed)
        );
      })
      .map((line) => line.trim())
      .join(" "),
  );
}

/**
 * Collect `- item` bullets from a slice, folding a plain continuation line (indented,
 * not a bullet, not blank) into the current item. Mirrors `decisionFieldItems`.
 */
function bulletItems(lines: readonly string[], start: number, end: number): string[] {
  const items: string[] = [];
  let continuation: string[] = [];
  const push = (): void => {
    const value = normalizeText(continuation.join(" "));
    if (value.length > 0) items.push(value);
    continuation = [];
  };
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) {
      push();
      continuation = [item];
      continue;
    }
    if (line.trim().length === 0) {
      push();
      continue;
    }
    continuation.push(line.trim());
  }
  push();
  return items;
}

// ── ADRs ─────────────────────────────────────────────────────────────────────

function parseAdr(doc: GrillDoc): GrillDecision[] {
  const lines = visibleLines(toLines(doc.md));
  const headings = findHeadings(lines);
  const title = headings.find((heading) => heading.level === 1);
  if (title === undefined || title.title.length === 0) return [];

  const firstSection = headings.find(
    (heading) => heading.level === 2 && heading.index > title.index,
  );
  const rationale = textBetween(lines, title.index + 1, firstSection?.index ?? lines.length);

  const options = headings.find(
    (heading) => heading.level === 2 && /^Considered Options$/i.test(heading.title),
  );
  const alternatives =
    options === undefined
      ? []
      : bulletItems(lines, options.index + 1, sectionEnd(lines, headings, options));

  return [
    {
      title: title.title,
      ...(rationale.length === 0 ? {} : { rationale }),
      alternatives,
      source: { path: doc.path, line: title.index + 1 },
    },
  ];
}

// ── CONTEXT.md glossary (a `## Language` section) ──────────────────────────────

/** A `**term**: definition` line-start (optionally bulleted). */
function glossaryTermStart(
  line: string,
): { readonly term: string; readonly definition: string } | undefined {
  const match = /^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*:\s*(.*?)\s*$/.exec(line);
  if (match === null) return undefined;
  const term = normalizeText(match[1] ?? "");
  if (term.length === 0) return undefined;
  return { term, definition: normalizeText(match[2] ?? "") };
}

/** An `_Avoid_: a, b, c` line: the comma-split values (possibly empty), or `undefined`. */
function glossaryAvoid(line: string): string[] | undefined {
  const match = /^\s*(?:[-*+]\s+)?_Avoid_:\s*(.*?)\s*$/i.exec(line);
  if (match === null) return undefined;
  return (match[1] ?? "")
    .split(",")
    .map(normalizeText)
    .filter((value) => value.length > 0);
}

function parseGlossary(doc: GrillDoc): GrillGlossaryTerm[] {
  const lines = visibleLines(toLines(doc.md));
  const headings = findHeadings(lines);
  const language = headings.find(
    (heading) => heading.level === 2 && /^Language$/i.test(heading.title),
  );
  if (language === undefined) return [];
  const end = sectionEnd(lines, headings, language);
  const groupHeadings = headings.filter(
    (heading) => heading.level === 3 && heading.index > language.index && heading.index < end,
  );

  const starts: { readonly index: number; readonly term: string; readonly definition: string }[] =
    [];
  for (let index = language.index + 1; index < end; index += 1) {
    const start = glossaryTermStart(lines[index] ?? "");
    if (start !== undefined) starts.push({ index, ...start });
  }

  const terms: GrillGlossaryTerm[] = [];
  for (const [position, start] of starts.entries()) {
    const nextTerm = starts[position + 1]?.index ?? end;
    const nextHeading = headings.find(
      (heading) => heading.index > start.index && heading.index < nextTerm,
    )?.index;
    const termEnd = nextHeading ?? nextTerm;

    // The `_Avoid_` line (when present) closes the definition. When the entry states
    // none, the definition runs to the entry's end and `avoid` is honestly empty.
    let avoidIndex: number | undefined;
    let avoid: readonly string[] = [];
    for (let index = start.index + 1; index < termEnd; index += 1) {
      const parsed = glossaryAvoid(lines[index] ?? "");
      if (parsed === undefined) continue;
      avoidIndex = index;
      avoid = parsed;
      break;
    }

    const continuation = lines
      .slice(start.index + 1, avoidIndex ?? termEnd)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^#{1,6}\s+/.test(line));
    const definition = normalizeText([start.definition, ...continuation].join(" "));
    if (definition.length === 0) continue;

    const group = [...groupHeadings].reverse().find((heading) => heading.index < start.index);
    terms.push({
      term: start.term,
      definition,
      avoid: [...avoid],
      ...(group === undefined ? {} : { group: group.title }),
      source: { path: doc.path, line: start.index + 1 },
    });
  }
  return terms;
}

// ── Context-map tables (tech-stack / architecture tables) ──────────────────────

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line.trimEnd());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

/** Split a table row into trimmed cell texts (dropping the leading/trailing pipes). */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => normalizeText(cell));
}

function parseContextMaps(doc: GrillDoc): GrillContextMap[] {
  const lines = visibleLines(toLines(doc.md));
  const headings = findHeadings(lines);
  const maps: GrillContextMap[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (!isTableRow(line) || !isTableSeparator(next)) continue;

    const headers = tableCells(line);
    const rows: GrillContextRow[] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const rowLine = lines[cursor] ?? "";
      if (!isTableRow(rowLine) || isTableSeparator(rowLine)) break;
      rows.push({ cells: tableCells(rowLine), source: { path: doc.path, line: cursor + 1 } });
      cursor += 1;
    }

    if (rows.length > 0) {
      const heading = [...headings].reverse().find((candidate) => candidate.index < index);
      maps.push({
        ...(heading === undefined ? {} : { heading: heading.title }),
        headers,
        rows,
        source: { path: doc.path, line: index + 1 },
      });
    }
    index = cursor - 1;
  }
  return maps;
}

/**
 * Parse a whole grill-with-docs specification into the structured model the Design
 * board renders. Every array is empty (never absent) when the source states nothing
 * of that kind; a `CONTEXT.md` may contribute both glossary terms and context maps.
 */
export function parseGrillSpec(source: GrillSpecSource): GrillSpec {
  const contextDocs = source.contextDocs ?? [];
  return {
    decisions: (source.adrs ?? []).flatMap(parseAdr),
    glossary: contextDocs.flatMap(parseGlossary),
    contextMaps: contextDocs.flatMap(parseContextMaps),
  };
}
