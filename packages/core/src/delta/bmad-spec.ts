import type {
  BmadAcceptanceCriterion,
  BmadArchitecture,
  BmadBlock,
  BmadEpic,
  BmadListItem,
  BmadPrd,
  BmadRequirement,
  BmadSection,
  BmadSource,
  BmadSpec,
  BmadStory,
  BmadStoryDoc,
  BmadTaskGroup,
  BmadTaskItem,
  BmadTechnicalAssumption,
  BmadTechStack,
} from "@rennet/protocol";

/**
 * Parse a BMAD specification's markdown documents into a STRUCTURED model.
 *
 * A BMAD project ships a fixed, known set of document kinds — a `prd.md`, an
 * `architecture.md`, and per-feature `epic`/`story` documents — and each has a known
 * shape (a requirement registry, technical-assumption choices, a tech-stack table,
 * stories carrying a status and acceptance criteria, tasks/subtasks with `(AC: …)`
 * markers). Because the shape is known ahead of time, the Design lens can render it
 * structured rather than dumping the raw markdown. This module is that parser, the
 * sibling of `parseOpenSpecChange`: it is node-free (pure string work, no fs), so the
 * reader is a plain function of the document text and every rule is unit-testable.
 *
 * The parser is deliberately tolerant: any document may be absent, sections may be
 * missing or empty, and it never throws on well-formed-but-sparse input. A spec with
 * only a `prd.md` parses to a spec whose `architecture` is absent and whose
 * `epics`/`stories` are empty. Every reviewable node carries a `source` (artifact +
 * owning document path + 1-based line) a durable disposition anchors to.
 */

/** The raw document text for one BMAD specification (what an adapter reads off disk). */
export interface BmadSpecSource {
  /** The specification's anchor label (the touched story id, epic, or PRD the reader selected). */
  readonly name: string;
  readonly prdMd?: string;
  readonly architectureMd?: string;
  /** Epic documents, keyed by their repo-relative path. */
  readonly epics?: readonly { readonly path: string; readonly md: string }[];
  /** Story documents, keyed by their repo-relative path. */
  readonly stories?: readonly { readonly path: string; readonly md: string }[];
}

type BmadArtifact = BmadSource["artifact"];

/** A per-document source factory: 1-based file line → the node's `source` origin. */
function sourceFactory(artifact: BmadArtifact, document?: string): (line: number) => BmadSource {
  return (line) => (document !== undefined ? { artifact, document, line } : { artifact, line });
}

/**
 * The source-origin base for a run of lines handed to `parseBlocks`: which document
 * they came from and the 1-based file line of the FIRST line in the run. A node's
 * `source.line` is `baseLine + itsLocalIndex`.
 */
interface SourceBase {
  readonly source: (line: number) => BmadSource;
  /** 1-based file line of `lines[0]` in the slice being parsed. */
  readonly baseLine: number;
}

function sourceAt(base: SourceBase | undefined, localIndex: number): BmadSource | undefined {
  if (!base) return undefined;
  return base.source(base.baseLine + localIndex);
}

// ── shared markdown primitives (mirrors openspec-change.ts) ───────────────────

/** Split into lines, tolerating CRLF, with no trailing carriage returns. */
function toLines(md: string): string[] {
  return md.replace(/\r\n?/g, "\n").split("\n");
}

/** Collapse runs of whitespace to single spaces and trim. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A URL/anchor slug from a heading (lowercase, non-alphanumerics collapsed to `-`). */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True for a `---`/`***`/`___` horizontal rule (a section separator we drop). */
function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])\1{2,}\s*$/.test(line);
}

/** A markdown table row (`| a | b |`). */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line.trimEnd());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

/** Split a table row into trimmed cell texts (dropping the leading/trailing pipes). */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const LIST_MARKER = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

/**
 * Split one list line's body into an optional bolded lead-in and the remainder
 * (the `**Lead.** the rest…` idiom). When there is no leading bold, the whole line is
 * the text and there is no lead.
 */
function splitListItem(body: string, source: BmadSource | undefined): BmadListItem {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(body);
  if (bold) {
    const lead = (bold[1] ?? "").trim();
    const rest = (bold[2] ?? "").replace(/^[—–:-]\s*/, "").trim();
    if (rest.length === 0) return source ? { text: lead, source } : { text: lead };
    return source ? { lead, text: rest, source } : { lead, text: rest };
  }
  return source ? { text: body.trim(), source } : { text: body.trim() };
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function isClosingFence(line: string): boolean {
  return /^\s*```\s*$/.test(line);
}

/**
 * Walk a block of lines into ordered rendered blocks: paragraphs, lists, fenced code,
 * and tables. A blank line separates blocks; a `---` rule is dropped.
 */
function parseBlocks(lines: readonly string[], base?: SourceBase): BmadBlock[] {
  const blocks: BmadBlock[] = [];
  let i = 0;
  const src = (start: number) => sourceAt(base, start);
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || isHorizontalRule(line)) {
      i += 1;
      continue;
    }
    const start = i;

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const language = (fence[1] ?? "").trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isClosingFence(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // consume the closing fence (if any)
      blocks.push({ kind: "code", language, code: body.join("\n"), source: src(start) });
      continue;
    }

    const nextLine = lines[i + 1] ?? "";
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(nextLine)) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      i += 2; // header + separator
      while (i < lines.length) {
        const rowLine = lines[i] ?? "";
        if (!isTableRow(rowLine) || isTableSeparator(rowLine)) break;
        rows.push(tableCells(rowLine));
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows, source: src(start) });
      continue;
    }

    if (LIST_MARKER.test(line)) {
      const items: BmadListItem[] = [];
      const ordered = /^\s*\d+\.\s/.test(line);
      while (i < lines.length) {
        const match = LIST_MARKER.exec(lines[i] ?? "");
        if (!match) break;
        const itemStart = i;
        let body = match[3] ?? "";
        while (i + 1 < lines.length) {
          const cont = lines[i + 1] ?? "";
          if (cont.trim().length === 0 || LIST_MARKER.test(cont) || !/^\s+/.test(cont)) break;
          body += ` ${cont.trim()}`;
          i += 1;
        }
        items.push(splitListItem(body.trim(), src(itemStart)));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items, source: src(start) });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      const curNext = lines[i + 1] ?? "";
      if (
        cur.trim().length === 0 ||
        isHorizontalRule(cur) ||
        isFence(cur) ||
        LIST_MARKER.test(cur) ||
        (isTableRow(cur) && i + 1 < lines.length && isTableSeparator(curNext))
      ) {
        break;
      }
      para.push(cur.trim());
      i += 1;
    }
    if (para.length > 0)
      blocks.push({ kind: "paragraph", text: para.join(" "), source: src(start) });
  }
  return blocks;
}

/** A heading match: its level (number of `#`), its trimmed text, and its 0-based line. */
interface Heading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

function findHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.push({ level: (match[1] ?? "").length, text: (match[2] ?? "").trim(), line: i });
    }
  }
  return headings;
}

/** The 0-based end line of a heading's nested section: the next heading of level ≤ its own. */
function sectionEndLine(headings: readonly Heading[], heading: Heading, lineCount: number): number {
  return (
    headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level)
      ?.line ?? lineCount
  );
}

/**
 * The lines OWNED by a heading, stopping at the NEXT heading of ANY level, so a
 * nested-section document renders each heading exactly once (mirrors openspec `ownBody`).
 */
function ownBody(lines: readonly string[], headings: readonly Heading[], index: number): string[] {
  const heading = headings[index];
  if (!heading) return [];
  const next = headings[index + 1];
  const end = next ? next.line : lines.length;
  return lines.slice(heading.line + 1, end);
}

/** The visible text of a line-range: non-empty, non-heading, non-rule lines joined by spaces. */
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

// ── the document tree (every BMAD document carries one) ──────────────────────

function parseSections(
  lines: readonly string[],
  source: (line: number) => BmadSource,
): BmadSection[] {
  const headings = findHeadings(lines);
  const sections: BmadSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading) continue;
    sections.push({
      id: slugify(heading.text),
      level: heading.level,
      heading: heading.text,
      blocks: parseBlocks(ownBody(lines, headings, i), { source, baseLine: heading.line + 2 }),
      source: source(heading.line + 1),
    });
  }
  return sections;
}

// ── PRD requirement registry (FR1 / NFR2) ────────────────────────────────────

function parseRequirements(
  lines: readonly string[],
  headings: readonly Heading[],
  source: (line: number) => BmadSource,
): BmadRequirement[] {
  const requirements: BmadRequirement[] = [];
  const sections = headings.filter(
    (heading) => heading.level === 2 && /^Requirements$/i.test(heading.text),
  );
  for (const section of sections) {
    const end = sectionEndLine(headings, section, lines.length);
    for (let index = section.line + 1; index < end; index += 1) {
      const match = /^\s*(?:(?:[-*+] |\d+[.)] ))?((?:N?FR)\d+)\s*:\s*(.+?)\s*$/i.exec(
        lines[index] ?? "",
      );
      if (match === null) continue;
      const id = (match[1] ?? "").toUpperCase();
      requirements.push({
        id,
        kind: id.startsWith("NFR") ? "non-functional" : "functional",
        text: normalizeText(match[2] ?? ""),
        source: source(index + 1),
      });
    }
  }
  return requirements;
}

// ── PRD technical-assumption choices ─────────────────────────────────────────

const TECHNICAL_ASSUMPTION_LABELS = new Set([
  "repository structure",
  "service architecture",
  "testing requirements",
]);

function parseTechnicalAssumptions(
  lines: readonly string[],
  headings: readonly Heading[],
  source: (line: number) => BmadSource,
): BmadTechnicalAssumption[] {
  const section = headings.find(
    (heading) => heading.level === 2 && /^Technical Assumptions$/i.test(heading.text),
  );
  if (section === undefined) return [];
  const end = sectionEndLine(headings, section, lines.length);
  const assumptions: BmadTechnicalAssumption[] = [];
  for (let index = section.line + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    const match =
      /^\s*(?:[-*+]\s+)?\*\*(.+?):\*\*\s*(\S(?:.*\S)?)\s*$/.exec(line) ??
      /^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*:\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (match === null) continue;
    const label = normalizeText(match[1] ?? "");
    const value = normalizeText(match[2] ?? "");
    if (!TECHNICAL_ASSUMPTION_LABELS.has(label.toLowerCase()) || value.length === 0) continue;
    assumptions.push({ label, value, source: source(index + 1) });
  }
  return assumptions;
}

// ── architecture tech-stack table ────────────────────────────────────────────

function parseTechStack(
  lines: readonly string[],
  headings: readonly Heading[],
  source: (line: number) => BmadSource,
): BmadTechStack | undefined {
  const section = headings.find(
    (heading) => heading.level === 2 && /^Tech Stack$/i.test(heading.text),
  );
  if (section === undefined) return undefined;
  const end = sectionEndLine(headings, section, lines.length);
  const rows = lines
    .slice(section.line + 1, end)
    .map((line, offset) => ({ line, index: section.line + 1 + offset }))
    .filter(({ line }) => isTableRow(line));
  const header = rows[0];
  if (rows.length < 3 || header === undefined || !/\bTechnology\b/i.test(header.line)) {
    return undefined;
  }
  const headers = tableCells(header.line);
  const rationaleIndex = headers.findIndex((cell) => /^Rationale$/i.test(cell));
  const dataRows: BmadTechStack["rows"] = [];
  for (const { line, index } of rows.slice(2)) {
    const cells = tableCells(line);
    if (cells.length === 0 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rationale = rationaleIndex < 0 ? undefined : cells[rationaleIndex];
    dataRows.push({
      cells,
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
      source: source(index + 1),
    });
  }
  return { headers, rows: dataRows, source: source(header.index + 1) };
}

// ── stories (statement, status, acceptance criteria) ─────────────────────────

interface NumberedItem {
  readonly id: string;
  readonly text: string;
  /** 1-based file line. */
  readonly line: number;
}

function numberedItems(lines: readonly string[], start: number, end: number): NumberedItem[] {
  const items: NumberedItem[] = [];
  let current: { id: string; parts: string[]; line: number } | undefined;
  const push = (): void => {
    if (current === undefined) return;
    items.push({
      id: current.id,
      text: normalizeText(current.parts.join(" ")),
      line: current.line,
    });
    current = undefined;
  };
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    const item = /^\s*(\d+)[.):]\s+(.+?)\s*$/.exec(line);
    if (item !== null) {
      push();
      current = { id: item[1] ?? "", parts: [item[2] ?? ""], line: index + 1 };
      continue;
    }
    if (current !== undefined && /^\s+\S/.test(line) && !/^\s*#{1,6}\s+/.test(line)) {
      current.parts.push(line.trim());
      continue;
    }
    if (line.trim().length > 0) push();
  }
  push();
  return items;
}

function storyId(headings: readonly Heading[], heading: Heading, documentPath?: string): string {
  const explicit = /^Story\s+(\d+(?:\.\d+)*)\b/i.exec(heading.text)?.[1];
  if (explicit !== undefined) return explicit;
  const titleId = headings
    .filter((candidate) => candidate.level === 1 && candidate.line < heading.line)
    .flatMap((candidate) => {
      const id = /^Story\s+(\d+(?:\.\d+)*)\b/i.exec(candidate.text)?.[1];
      return id === undefined ? [] : [id];
    })
    .at(-1);
  if (titleId !== undefined) return titleId;
  return /(?:^|\/)(\d+(?:\.\d+)+)[.-]/.exec(documentPath ?? "")?.[1] ?? "story";
}

function storyStatement(
  lines: readonly string[],
  headings: readonly Heading[],
  heading: Heading,
): string {
  const nextHeading = headings.find((candidate) => candidate.line > heading.line);
  const end = nextHeading?.line ?? lines.length;
  const parts: string[] = [];
  for (let index = heading.line + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const plain = line.replace(/\*\*/g, "").trim();
    if (parts.length === 0 && !/^As a\b/i.test(plain)) continue;
    parts.push(line.trim());
  }
  return normalizeText(parts.join(" "));
}

function storyTitle(headings: readonly Heading[], heading: Heading, id: string): string {
  if (!/^Story$/i.test(heading.text)) return heading.text;
  return (
    [...headings]
      .reverse()
      .find(
        (candidate) =>
          candidate.level === 1 &&
          candidate.line < heading.line &&
          new RegExp(`^Story\\s+${id.replace(/\./g, "\\.")}\\b`, "i").test(candidate.text),
      )?.text ?? `Story ${id}`
  );
}

function parseStories(
  lines: readonly string[],
  source: (line: number) => BmadSource,
  documentPath?: string,
): BmadStory[] {
  const headings = findHeadings(lines);
  const storyHeadings = headings.filter(
    (heading) =>
      heading.level > 1 &&
      (/^Story$/i.test(heading.text) || /^Story\s+\d+(?:\.\d+)*\b/i.test(heading.text)),
  );
  const stories: BmadStory[] = [];
  for (const [storyIndex, heading] of storyHeadings.entries()) {
    const id = storyId(headings, heading, documentPath);
    const statement = storyStatement(lines, headings, heading);
    const nextStory = storyHeadings[storyIndex + 1];
    const storyRoot = [...headings]
      .reverse()
      .find(
        (candidate) =>
          candidate.level === 1 &&
          candidate.line < heading.line &&
          /^Story\s+\d+(?:\.\d+)*\b/i.test(candidate.text),
      );
    const nextStoryRoot =
      storyRoot === undefined
        ? undefined
        : headings.find(
            (candidate) =>
              candidate.level === 1 &&
              candidate.line > storyRoot.line &&
              /^Story\s+\d+(?:\.\d+)*\b/i.test(candidate.text),
          );
    const storyStart = storyRoot?.line ?? heading.line;
    const storyEnd = nextStoryRoot?.line ?? nextStory?.line ?? lines.length;
    const acceptanceHeading = headings.find(
      (candidate) =>
        candidate.line > heading.line &&
        candidate.line < storyEnd &&
        /^Acceptance Criteria$/i.test(candidate.text),
    );
    const statusHeading = headings.find(
      (candidate) =>
        candidate.line > storyStart &&
        candidate.line < storyEnd &&
        /^Status$/i.test(candidate.text),
    );
    const status =
      statusHeading === undefined
        ? undefined
        : textBetween(
            lines,
            statusHeading.line + 1,
            sectionEndLine(headings, statusHeading, lines.length),
          );
    const acceptanceCriteria: BmadAcceptanceCriterion[] =
      acceptanceHeading === undefined
        ? []
        : numberedItems(
            lines,
            acceptanceHeading.line + 1,
            sectionEndLine(headings, acceptanceHeading, lines.length),
          ).map((item) => ({ id: item.id, text: item.text, source: source(item.line) }));
    if (statement.length === 0 && acceptanceCriteria.length === 0) continue;
    stories.push({
      id,
      title: storyTitle(headings, heading, id),
      statement,
      ...(status === undefined || status.length === 0 ? {} : { status }),
      acceptanceCriteria,
      source: source(heading.line + 1),
    });
  }
  return stories;
}

// ── story tasks / subtasks ───────────────────────────────────────────────────

interface Checkbox {
  readonly body: string;
  readonly done: boolean;
  readonly indent: number;
  /** 1-based file line. */
  readonly line: number;
}

function checkboxesIn(lines: readonly string[], start: number, end: number): Checkbox[] {
  const found: Checkbox[] = [];
  for (let index = start; index < end; index += 1) {
    const match = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (match === null) continue;
    found.push({
      body: normalizeText(match[3] ?? ""),
      done: (match[2] ?? "").toLowerCase() === "x",
      indent: (match[1] ?? "").length,
      line: index + 1,
    });
  }
  return found;
}

function leadingNumber(text: string): string | undefined {
  return /^(\d+(?:\.\d+)*)[.)]?\s+/.exec(text.replace(/^\*\*/, ""))?.[1];
}

function namedNumber(text: string, name: "Task" | "Subtask"): string | undefined {
  const match = new RegExp(`^(?:\\*\\*)?${name}\\s+(\\d+(?:\\.\\d+)*)\\b`, "i").exec(text);
  return match?.[1];
}

function acceptanceRefs(body: string): string[] | undefined {
  const refs = /\(AC:\s*([^)]+)\)/i.exec(body)?.[1]?.split(",").map(normalizeText).filter(Boolean);
  return refs === undefined || refs.length === 0 ? undefined : refs;
}

function parseTasks(
  lines: readonly string[],
  source: (line: number) => BmadSource,
): BmadTaskGroup[] {
  const headings = findHeadings(lines);
  const section = headings.find((heading) => /^Tasks\s*\/\s*Subtasks$/i.test(heading.text));
  if (section === undefined) return [];
  const found = checkboxesIn(
    lines,
    section.line + 1,
    sectionEndLine(headings, section, lines.length),
  );
  if (found.length === 0) return [];
  const minimumIndent = Math.min(...found.map((checkbox) => checkbox.indent));

  const groups: BmadTaskGroup[] = [];
  let current: (BmadTaskGroup & { items: BmadTaskItem[] }) | undefined;
  const push = (): void => {
    if (current === undefined) return;
    current.total = current.items.length;
    current.done = current.items.filter((item) => item.status === "done").length;
    groups.push(current);
    current = undefined;
  };

  for (const checkbox of found) {
    if (checkbox.indent === minimumIndent) {
      push();
      const groupId =
        namedNumber(checkbox.body, "Task") ??
        leadingNumber(checkbox.body) ??
        String(groups.length + 1);
      const refs = acceptanceRefs(checkbox.body);
      current = {
        id: `task-group:${groupId}`,
        title: checkbox.body,
        status: checkbox.done ? "done" : "todo",
        ...(refs === undefined ? {} : { acceptanceCriteriaRefs: refs }),
        items: [],
        total: 0,
        done: 0,
        source: source(checkbox.line),
      };
      continue;
    }
    if (current === undefined) continue;
    const refs = acceptanceRefs(checkbox.body);
    current.items.push({
      text: checkbox.body,
      status: checkbox.done ? "done" : "todo",
      indent: checkbox.indent,
      ...(refs === undefined ? {} : { acceptanceCriteriaRefs: refs }),
      source: source(checkbox.line),
    });
  }
  push();
  return groups;
}

// ── per-document parsers ─────────────────────────────────────────────────────

function parsePrd(md: string): BmadPrd {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const source = sourceFactory("prd");
  return {
    sections: parseSections(lines, source),
    requirements: parseRequirements(lines, headings, source),
    technicalAssumptions: parseTechnicalAssumptions(lines, headings, source),
    stories: parseStories(lines, source),
  } as BmadPrd;
}

function parseArchitecture(md: string): BmadArchitecture {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const source = sourceFactory("architecture");
  const techStack = parseTechStack(lines, headings, source);
  return {
    sections: parseSections(lines, source),
    ...(techStack === undefined ? {} : { techStack }),
  } as BmadArchitecture;
}

function parseEpic(path: string, md: string): BmadEpic {
  const lines = toLines(md);
  const source = sourceFactory("epic", path);
  return {
    path,
    sections: parseSections(lines, source),
    stories: parseStories(lines, source, path),
  } as BmadEpic;
}

function parseStoryDoc(path: string, md: string): BmadStoryDoc {
  const lines = toLines(md);
  const source = sourceFactory("story", path);
  const stories = parseStories(lines, source, path);
  const story = stories[0];
  return {
    path,
    sections: parseSections(lines, source),
    ...(story === undefined ? {} : { story }),
    tasks: parseTasks(lines, source),
  } as BmadStoryDoc;
}

/**
 * Parse a whole BMAD specification's document text into the structured model the Design
 * lens renders. Absent documents are simply absent on the result; `epics`/`stories` are
 * empty (never absent) when none were supplied. Never throws.
 */
export function parseBmadSpec(source: BmadSpecSource): BmadSpec {
  return {
    name: source.name,
    prd: source.prdMd !== undefined ? parsePrd(source.prdMd) : undefined,
    architecture:
      source.architectureMd !== undefined ? parseArchitecture(source.architectureMd) : undefined,
    epics: (source.epics ?? []).map((epic) => parseEpic(epic.path, epic.md)),
    stories: (source.stories ?? []).map((story) => parseStoryDoc(story.path, story.md)),
    // Carry the raw document text verbatim alongside the parsed model (mirrors #239).
    raw: {
      ...(source.prdMd !== undefined ? { prdMd: source.prdMd } : {}),
      ...(source.architectureMd !== undefined ? { architectureMd: source.architectureMd } : {}),
      epics: (source.epics ?? []).map((epic) => ({ path: epic.path, md: epic.md })),
      stories: (source.stories ?? []).map((story) => ({ path: story.path, md: story.md })),
    },
  };
}
