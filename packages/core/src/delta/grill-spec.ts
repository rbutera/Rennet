import type {
  GrillContext,
  GrillContextMap,
  GrillDecision,
  GrillGlossaryTerm,
  GrillRelationship,
  GrillSpec,
} from "@rennet/protocol";

/**
 * Parse a grill-with-docs specification's markdown into a STRUCTURED model.
 *
 * grill-with-docs is the sparse, doc-driven spec format written by Matt Pocock's
 * `domain-modeling` companion: architecture decision records (`docs/adr/**`,
 * `docs/decisions/**`), a `CONTEXT.md` glossary (a `## Language` list of
 * `**term**` / definition / `_Avoid_` entries), and — only in a multi-context repo —
 * a root `CONTEXT-MAP.md` naming each context (`## Contexts`) and the directional
 * edges between them (`## Relationships`). Unlike an OpenSpec change, it ships no
 * fixed artifact set and no requirement/scenario tree — a thin ADR is a legitimate
 * whole specification. This module is the parser that mirrors `openspec-change.ts`:
 * it is node-free (pure string work, no fs), so the reader is a plain function of the
 * document text and every rule is unit-testable.
 *
 * It is deliberately tolerant: any document may be absent, a section may be missing
 * or empty, and it never throws on well-formed-but-sparse input. Absence is
 * represented HONESTLY — a decision that states no alternatives carries an empty
 * array, a glossary entry with no stated `_Avoid_` carries an empty `avoid`, and a
 * single-context repo (no `CONTEXT-MAP.md`) carries an empty `contextMaps`. Nothing
 * is inferred from the diff; the model says only what the documents say. The verbatim
 * source text rides along in `raw` (#239) so a viewer can flip to it unchanged.
 */

/** One grill document read off disk: its repo-relative path and raw markdown. */
export interface GrillDoc {
  readonly path: string;
  readonly md: string;
}

/** The raw document text for one grill-with-docs specification (what an adapter reads). */
export interface GrillSpecSource {
  /** Architecture decision records (`docs/adr/**`, `docs/decisions/**`, at any depth). */
  readonly adrs?: readonly GrillDoc[];
  /** `CONTEXT.md` documents carrying a `## Language` glossary. */
  readonly contextDocs?: readonly GrillDoc[];
  /** `CONTEXT-MAP.md` documents (the multi-context marker) carrying contexts + relationships. */
  readonly contextMaps?: readonly GrillDoc[];
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
 * Blank out fenced code blocks so headings and lists inside a fence are never
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

/** A single-line `- item` bullet with its 0-based line index (no continuation folding). */
interface ListItem {
  readonly text: string;
  readonly index: number;
}

/** Every `- item` bullet in a slice, each carrying its own source line. */
function listItems(lines: readonly string[], start: number, end: number): ListItem[] {
  const items: ListItem[] = [];
  for (let index = start; index < end; index += 1) {
    const text = /^\s*[-*+]\s+(.+?)\s*$/.exec(lines[index] ?? "")?.[1];
    if (text !== undefined) items.push({ text: text.trim(), index });
  }
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

/** A `**term**:` line-start (optionally bulleted), definition possibly on the next line. */
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

// ── CONTEXT-MAP.md (multi-context: `## Contexts` + `## Relationships`) ─────────

/** Strip a leading summary separator (` - `, ` — `, `:`) off a contexts-list tail. */
function stripSummarySeparator(tail: string): string {
  return tail.replace(/^\s*[-–—:]\s*/, "").trim();
}

/**
 * One `## Contexts` entry: a Markdown link `[name](href)` with an optional trailing
 * summary, or a bare `name` with an optional `- summary` / `: summary`.
 */
function parseContextItem(item: ListItem, path: string): GrillContext {
  const source = { path, line: item.index + 1 };
  const link = /^\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/.exec(item.text);
  if (link !== null) {
    const summary = stripSummarySeparator(link[3] ?? "");
    return {
      name: normalizeText(link[1] ?? ""),
      href: (link[2] ?? "").trim(),
      ...(summary.length === 0 ? {} : { summary }),
      source,
    };
  }
  // Bare name: split off an optional summary at the first ` - ` / ` — ` / `: `.
  const bare = /^(.+?)(?:\s+[-–—:]\s+(.*))?$/.exec(item.text);
  const summary = normalizeText(bare?.[2] ?? "");
  return {
    name: normalizeText(bare?.[1] ?? item.text),
    ...(summary.length === 0 ? {} : { summary }),
    source,
  };
}

// Directional arrows the format uses, ascii and unicode.
const RELATIONSHIP_ARROW = /\s(<->|<-|->|↔|→|←)\s/;

/**
 * One `## Relationships` edge (`Ordering → Fulfillment`, `Ordering ↔ Billing`), with
 * an optional trailing `: label` / `— label`. A reversed arrow (`←`/`<-`) is
 * normalised by swapping `from`/`to`. Returns `undefined` for a line with no arrow.
 */
function parseRelationshipItem(item: ListItem, path: string): GrillRelationship | undefined {
  const arrow = RELATIONSHIP_ARROW.exec(item.text);
  if (arrow === null || arrow.index === undefined) return undefined;
  const token = arrow[1] ?? "";
  const left = normalizeText(item.text.slice(0, arrow.index));
  let rest = item.text.slice(arrow.index + arrow[0].length);

  // A label may trail after a `:` or em/en dash separator. A hyphen is NOT a label
  // separator here — context names routinely contain hyphens.
  let label: string | undefined;
  const labelMatch = /\s*[:–—]\s*(.*)$/.exec(rest);
  if (labelMatch !== null && labelMatch.index !== undefined) {
    label = normalizeText(labelMatch[1] ?? "");
    rest = rest.slice(0, labelMatch.index);
  }
  const right = normalizeText(rest);
  if (left.length === 0 || right.length === 0) return undefined;

  const reversed = token === "<-" || token === "←";
  const bidirectional = token === "<->" || token === "↔";
  return {
    from: reversed ? right : left,
    to: reversed ? left : right,
    direction: bidirectional ? "<->" : "->",
    ...(label === undefined || label.length === 0 ? {} : { label }),
    source: { path, line: item.index + 1 },
  };
}

/**
 * Parse a `CONTEXT-MAP.md` into one context map: its `## Contexts` entries and
 * `## Relationships` edges. The file's mere presence marks the repo multi-context, so
 * one map is emitted per file even when a section is missing (its list is then empty).
 */
function parseContextMap(doc: GrillDoc): GrillContextMap[] {
  const lines = visibleLines(toLines(doc.md));
  const headings = findHeadings(lines);

  const contextsHeading = headings.find(
    (heading) => heading.level === 2 && /^Contexts$/i.test(heading.title),
  );
  const relationshipsHeading = headings.find(
    (heading) => heading.level === 2 && /^Relationships$/i.test(heading.title),
  );

  const contexts =
    contextsHeading === undefined
      ? []
      : listItems(
          lines,
          contextsHeading.index + 1,
          sectionEnd(lines, headings, contextsHeading),
        ).map((item) => parseContextItem(item, doc.path));

  const relationships =
    relationshipsHeading === undefined
      ? []
      : listItems(
          lines,
          relationshipsHeading.index + 1,
          sectionEnd(lines, headings, relationshipsHeading),
        )
          .map((item) => parseRelationshipItem(item, doc.path))
          .filter((edge): edge is GrillRelationship => edge !== undefined);

  return [{ contexts, relationships, source: { path: doc.path, line: 1 } }];
}

/**
 * Parse a whole grill-with-docs specification into the structured model the Design
 * board renders. Every array is empty (never absent) when the source states nothing
 * of that kind. The verbatim source text rides along in `raw` (#239).
 */
export function parseGrillSpec(source: GrillSpecSource): GrillSpec {
  const adrs = source.adrs ?? [];
  const contextDocs = source.contextDocs ?? [];
  const contextMaps = source.contextMaps ?? [];
  return {
    decisions: adrs.flatMap(parseAdr),
    glossary: contextDocs.flatMap(parseGlossary),
    contextMaps: contextMaps.flatMap(parseContextMap),
    raw: {
      adrs: adrs.map((doc) => ({ path: doc.path, md: doc.md })),
      contextDocs: contextDocs.map((doc) => ({ path: doc.path, md: doc.md })),
      contextMaps: contextMaps.map((doc) => ({ path: doc.path, md: doc.md })),
    },
  };
}
