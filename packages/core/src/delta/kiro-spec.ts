import type {
  KiroBlock,
  KiroBugfix,
  KiroCriterion,
  KiroDesign,
  KiroListItem,
  KiroRequirement,
  KiroRequirements,
  KiroSource,
  KiroSpec,
  KiroTaskGroup,
  KiroTaskItem,
  KiroTasks,
} from "@rennet/protocol";

/**
 * The source-origin base for a run of lines handed to `parseBlocks`: which artifact
 * they came from and the 1-based file line of the FIRST line in the run. A node's
 * `source.line` is `baseLine + itsLocalIndex`, so every reviewable node carries the
 * real artifact file + line a durable disposition anchors to.
 */
interface SourceBase {
  readonly artifact: KiroSource["artifact"];
  /** 1-based file line of `lines[0]` in the slice being parsed. */
  readonly baseLine: number;
}

/** Build a node source from a base + the node's local (0-based) offset in the slice. */
function sourceAt(base: SourceBase | undefined, localIndex: number): KiroSource | undefined {
  if (!base) return undefined;
  return { artifact: base.artifact, line: base.baseLine + localIndex };
}

/**
 * Parse a Kiro spec's markdown artifacts into a STRUCTURED model.
 *
 * A Kiro feature ships a fixed, known set of artifacts under `.kiro/specs/<feature>/`
 * — a `requirements.md` (EARS-style requirements: a user story plus numbered
 * acceptance criteria), a `design.md` (a decision/architecture section tree), a
 * `tasks.md` (a numbered checklist whose items carry `_Requirements:` refs and
 * completion marks), and a `bugfix.md` variant (current/expected/unchanged behaviour
 * sections) — and each has a known shape. Because the shape is known ahead of time,
 * the Design angle renders it structured (requirement/criteria tree, task checklist +
 * progress, a design section tree) rather than dumping the raw markdown. This module
 * is that parser: it is node-free (pure string work, no fs), so the reader is a plain
 * function of the artifact text and every rule is unit-testable.
 *
 * The parser is deliberately tolerant: any artifact may be absent, sections may be
 * missing or empty, and the whole-feature roll-up counts only what is present. It
 * never throws on well-formed-but-sparse input; a feature with only a `requirements.md`
 * parses to a spec whose `design`/`tasks`/`bugfix` are absent.
 *
 * It mirrors `parseOpenSpecChange`, the OpenSpec sibling; the two share no code so
 * neither format's quirks bleed into the other, but the shapes and idioms match.
 */

/** The raw artifact text for one Kiro feature (what an adapter reads off disk). */
export interface KiroSpecSource {
  /** The feature directory name (`.kiro/specs/<feature>/`). */
  readonly feature: string;
  readonly requirementsMd?: string;
  readonly designMd?: string;
  readonly tasksMd?: string;
  readonly bugfixMd?: string;
}

/** Split into lines, tolerating CRLF, with no trailing carriage returns. */
function toLines(md: string): string[] {
  return md.replace(/\r\n?/g, "\n").split("\n");
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

/** A markdown table row (`| a | b |`). The separator row is `|---|:--:|`. */
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
 * Split one list line's body into an optional bolded lead-in and the remainder.
 * When there is no leading bold, the whole line is the text and there is no lead.
 */
function splitListItem(body: string, source: KiroSource | undefined): KiroListItem {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(body);
  if (bold) {
    const lead = (bold[1] ?? "").trim();
    const rest = (bold[2] ?? "").replace(/^[—–:-]\s*/, "").trim();
    // A wholly-bold item (no remainder) reads better as plain text than as an orphan
    // lead with an empty body.
    if (rest.length === 0) return source ? { text: lead, source } : { text: lead };
    return source ? { lead, text: rest, source } : { lead, text: rest };
  }
  return source ? { text: body.trim(), source } : { text: body.trim() };
}

/** True for the opening/closing of a fenced code block. */
function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function isClosingFence(line: string): boolean {
  return /^\s*```\s*$/.test(line);
}

/**
 * Walk a block of lines into ordered rendered blocks: paragraphs, lists, fenced code,
 * and tables. A blank line separates blocks; a `---` rule is dropped. This is the
 * shared renderer for design and bugfix sections.
 */
function parseBlocks(lines: readonly string[], base?: SourceBase): KiroBlock[] {
  const blocks: KiroBlock[] = [];
  let i = 0;
  const src = (start: number) => sourceAt(base, start);
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || isHorizontalRule(line)) {
      i += 1;
      continue;
    }
    const start = i;

    // Fenced code.
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

    // Table.
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

    // List (a run of consecutive marker lines; a continuation line indented under an
    // item is folded into it).
    if (LIST_MARKER.test(line)) {
      const items: KiroListItem[] = [];
      const ordered = /^\s*\d+\.\s/.test(line);
      while (i < lines.length) {
        const match = LIST_MARKER.exec(lines[i] ?? "");
        if (!match) break;
        const itemStart = i;
        let body = match[3] ?? "";
        // Fold plain continuation lines (indented, not a new marker, not blank).
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

    // Paragraph (run to the next blank line or block-start).
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

/** A heading match: its level (number of `#`) and its trimmed text. */
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
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      headings.push({ level: (match[1] ?? "").length, text: (match[2] ?? "").trim(), line: i });
    }
  }
  return headings;
}

/** The lines of a section: after its heading up to the next heading of level ≤ its own. */
function sectionBody(
  lines: readonly string[],
  headings: readonly Heading[],
  index: number,
): string[] {
  const heading = headings[index];
  if (!heading) return [];
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  const end = next ? next.line : lines.length;
  return lines.slice(heading.line + 1, end);
}

/**
 * The lines OWNED by a heading, stopping at the NEXT heading of ANY level (not just
 * level ≤ its own). A parent `##` therefore ends where its first `###` child begins,
 * so a nested-section document renders each heading exactly once — the child's prose
 * belongs to the child, never duplicated into the parent's body. (`sectionBody`
 * deliberately nests; this one deliberately does not.)
 */
function ownBody(lines: readonly string[], headings: readonly Heading[], index: number): string[] {
  const heading = headings[index];
  if (!heading) return [];
  const next = headings[index + 1];
  const end = next ? next.line : lines.length;
  return lines.slice(heading.line + 1, end);
}

/** The source base for a heading's body: its artifact + the 1-based line of the first body line. */
function bodyBase(
  headings: readonly Heading[],
  index: number,
  artifact: KiroSource["artifact"],
): SourceBase | undefined {
  const heading = headings[index];
  if (!heading) return undefined;
  return { artifact, baseLine: heading.line + 2 };
}

// ── requirements.md ──────────────────────────────────────────────────────────

/** The leading `1.2`-style number of a criterion/task line, ignoring a bold lead-in. */
function leadingNumber(text: string): string | undefined {
  return /^(\d+(?:\.\d+)*)[.)]?\s+/.exec(text.replace(/^\*\*/, ""))?.[1];
}

/**
 * Split an EARS acceptance criterion into its condition and response, or `undefined`
 * when the text is not a recognised EARS shape. Mirrors the obligation parser's
 * `scenarioClauses`: a comma-free `WHEN … THEN …`, an EARS `WHEN …, … SHALL …`, and a
 * `THE …` fallback are all handled; the words are the source's, never rephrased.
 */
function earsClause(text: string): KiroCriterion["ears"] {
  const plain = text.replace(/\*\*/g, "");
  const then = /\b(?:WHEN|IF|WHILE|WHERE)\b\s+(.+?)(?:\s+-)?\s+\bTHEN\b\s+(.+)$/i.exec(plain);
  if (then !== null) {
    const condition = (then[1] ?? "").replace(/\s+-$/, "").trim();
    const response = (then[2] ?? "").trim();
    return condition.length > 0 && response.length > 0 ? { condition, response } : undefined;
  }
  const ears = /\b(?:WHEN|IF|WHILE|WHERE)\b\s+(.+?),\s+(.+\bSHALL\b.+)$/i.exec(plain);
  if (ears !== null) {
    const condition = (ears[1] ?? "").trim();
    const response = (ears[2] ?? "").trim();
    return condition.length > 0 && response.length > 0 ? { condition, response } : undefined;
  }
  const trigger = /\b(?:WHEN|IF|WHILE|WHERE)\b\s+/i.exec(plain);
  if (trigger === null) return undefined;
  const body = plain.slice(trigger.index + trigger[0].length);
  const upper = body.toUpperCase();
  const shallIndex = upper.indexOf(" SHALL ");
  const responseIndex = shallIndex < 0 ? -1 : upper.lastIndexOf(" THE ", shallIndex);
  if (responseIndex < 0) return undefined;
  const condition = body.slice(0, responseIndex).trim();
  const response = body.slice(responseIndex + 1).trim();
  return condition.length > 0 && response.length > 0 ? { condition, response } : undefined;
}

interface NumberedLine {
  readonly id: string;
  readonly text: string;
  readonly line: number;
}

/**
 * Read the numbered items (`1. …`) in a slice, folding indented continuation lines
 * into the item they follow. `id` is the leading number verbatim; a line with no
 * leading number is skipped. `startLine` is the 1-based file line of `lines[0]`.
 */
function numberedItems(lines: readonly string[], startLine: number): NumberedLine[] {
  const items: NumberedLine[] = [];
  let current: { id: string; parts: string[]; line: number } | undefined;
  const push = (): void => {
    if (current === undefined) return;
    items.push({ id: current.id, text: current.parts.join(" ").trim(), line: current.line });
    current = undefined;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const item = /^\s*(\d+)[.):]\s+(.+?)\s*$/.exec(line);
    if (item !== null) {
      push();
      current = { id: item[1] ?? "", parts: [item[2] ?? ""], line: startLine + i };
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

function parseRequirement(
  lines: readonly string[],
  headings: readonly Heading[],
  reqIndex: number,
): KiroRequirement {
  const reqHeading = headings[reqIndex];
  const label = (reqHeading?.text ?? "").replace(/^Requirement\s+/i, "").trim();
  const numericLabel = /^(\d+(?:\.\d+)*)\b/.exec(label)?.[1];
  const id = numericLabel ?? (slugify(label) || "untitled");
  const source: KiroSource = { artifact: "requirements", line: (reqHeading?.line ?? 0) + 1 };
  if (!reqHeading) return { id, label: "", userStory: "", acceptanceCriteria: [], source };

  // The requirement ends at the next level-≤3 heading; its acceptance criteria live
  // under a level-4 `#### Acceptance Criteria` child within that span.
  const end = headings.slice(reqIndex + 1).find((h) => h.level <= 3);
  const reqEnd = end ? end.line : lines.length;
  const acceptanceHeading = headings.find(
    (h) =>
      h.line > reqHeading.line &&
      h.line < reqEnd &&
      h.level === 4 &&
      /^Acceptance Criteria$/i.test(h.text),
  );

  // Story = the prose between the requirement heading and its acceptance criteria (or
  // the requirement's end when there are none).
  const storyEnd = acceptanceHeading ? acceptanceHeading.line : reqEnd;
  const userStory = parseBlocks(lines.slice(reqHeading.line + 1, storyEnd))
    .flatMap((block) => (block.kind === "paragraph" ? [block.text] : []))
    .join(" ")
    .trim();

  const acceptanceCriteria: KiroCriterion[] = [];
  if (acceptanceHeading) {
    const acceptIndex = headings.indexOf(acceptanceHeading);
    const acceptEnd =
      headings.slice(acceptIndex + 1).find((h) => h.level <= acceptanceHeading.level)?.line ??
      lines.length;
    const startLine = acceptanceHeading.line + 2; // 1-based line of the first body line
    for (const item of numberedItems(
      lines.slice(acceptanceHeading.line + 1, acceptEnd),
      startLine,
    )) {
      const criterionId = numericLabel === undefined ? item.id : `${numericLabel}.${item.id}`;
      const ears = earsClause(item.text);
      acceptanceCriteria.push({
        id: criterionId,
        text: item.text,
        ...(ears ? { ears } : {}),
        source: { artifact: "requirements", line: item.line },
      });
    }
  }

  return { id, label: reqHeading.text, userStory, acceptanceCriteria, source };
}

function parseRequirements(md: string): KiroRequirements {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const requirements: KiroRequirement[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (heading?.level !== 3 || !/^Requirement\s+\S/i.test(heading.text)) continue;
    requirements.push(parseRequirement(lines, headings, i));
  }
  return { requirements } as KiroRequirements;
}

// ── design.md ────────────────────────────────────────────────────────────────

function parseDesign(md: string): KiroDesign {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const sections: KiroDesign["sections"] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading) continue;
    // The `#` title is the doc's name, not a section; the tree is `##`/`###`.
    if (heading.level < 2 || heading.level > 3) continue;
    sections.push({
      id: slugify(heading.text),
      level: heading.level as 2 | 3,
      heading: heading.text,
      // `ownBody`, not `sectionBody`: a `##` section stops at its first `###` child,
      // so nested headings render once (no duplicated child prose).
      blocks: parseBlocks(ownBody(lines, headings, i), bodyBase(headings, i, "design")),
      source: { artifact: "design", line: heading.line + 1 },
    });
  }
  return { sections } as KiroDesign;
}

// ── tasks.md ─────────────────────────────────────────────────────────────────

const TASK_ITEM = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const REQUIREMENTS_REF = /^\s*[-*+]\s+_Requirements?:\s*([^_]+)_\s*$/i;

/**
 * Parse the tasks checklist: numbered checkboxes grouped by their top-level number,
 * each item carrying its completion mark and the `_Requirements:` refs bound to it (a
 * ref line between this checkbox and the next). Groups keep source order; the group's
 * title is its first dot-free numbered checkbox (or its first member when none).
 */
function parseTasks(md: string): KiroTasks {
  const lines = toLines(md);
  const checkboxes: { number?: string; text: string; done: boolean; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = TASK_ITEM.exec(lines[i] ?? "");
    if (!match) continue;
    const body = (match[3] ?? "").trim();
    checkboxes.push({
      ...(leadingNumber(body) ? { number: leadingNumber(body) } : {}),
      text: body,
      done: (match[2] ?? "").toLowerCase() === "x",
      line: i,
    });
  }

  // Group id = the top-level segment of the item's number (`1.2` → `1`), else `root`.
  const groups = new Map<string, KiroTaskGroup>();
  const order: string[] = [];
  for (const [index, checkbox] of checkboxes.entries()) {
    const groupId = checkbox.number?.split(".")[0] ?? "root";
    let group = groups.get(groupId);
    if (!group) {
      group = {
        id: `task-group:${groupId}`,
        title: checkbox.text,
        items: [],
        total: 0,
        done: 0,
        source: { artifact: "tasks", line: checkbox.line + 1 },
      };
      groups.set(groupId, group);
      order.push(groupId);
    }
    // A dot-free numbered checkbox names the group (the section header line).
    if (checkbox.number !== undefined && !checkbox.number.includes(".")) {
      group.title = checkbox.text;
      group.source = { artifact: "tasks", line: checkbox.line + 1 };
    }

    const nextLine = checkboxes[index + 1]?.line ?? lines.length;
    const requirementRefs = lines.slice(checkbox.line + 1, nextLine).flatMap((line) => {
      const values = REQUIREMENTS_REF.exec(line)?.[1];
      if (values === undefined) return [];
      return values
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0);
    });

    const item: KiroTaskItem = {
      ...(checkbox.number ? { number: checkbox.number } : {}),
      text: checkbox.text,
      status: checkbox.done ? "done" : "todo",
      requirementRefs,
      source: { artifact: "tasks", line: checkbox.line + 1 },
    };
    group.items.push(item);
    group.total += 1;
    if (checkbox.done) group.done += 1;
  }

  const orderedGroups = order.map((id) => {
    const group = groups.get(id);
    if (!group) throw new Error("unreachable: group id from insertion order");
    return group;
  });
  const total = orderedGroups.reduce((sum, group) => sum + group.total, 0);
  const done = orderedGroups.reduce((sum, group) => sum + group.done, 0);
  return { groups: orderedGroups, total, done } as KiroTasks;
}

// ── bugfix.md ────────────────────────────────────────────────────────────────

function bugfixSection(text: string): "current" | "expected" | "unchanged" | undefined {
  const name = /^(Current|Expected|Unchanged)\s+Behaviou?r$/i.exec(text)?.[1]?.toLowerCase();
  return name === "current" || name === "expected" || name === "unchanged" ? name : undefined;
}

function parseBugfix(md: string): KiroBugfix {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const sections: KiroBugfix["sections"] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading) continue;
    const section = bugfixSection(heading.text);
    if (section === undefined) continue;
    sections.push({
      section,
      heading: heading.text,
      blocks: parseBlocks(sectionBody(lines, headings, i), bodyBase(headings, i, "bugfix")),
      source: { artifact: "bugfix", line: heading.line + 1 },
    });
  }
  return { sections } as KiroBugfix;
}

/**
 * Parse a whole Kiro spec's artifact text into the structured model the Design angle
 * renders. Absent artifacts are simply absent on the result.
 */
export function parseKiroSpec(source: KiroSpecSource): KiroSpec {
  return {
    feature: source.feature,
    requirements:
      source.requirementsMd !== undefined ? parseRequirements(source.requirementsMd) : undefined,
    design: source.designMd !== undefined ? parseDesign(source.designMd) : undefined,
    tasks: source.tasksMd !== undefined ? parseTasks(source.tasksMd) : undefined,
    bugfix: source.bugfixMd !== undefined ? parseBugfix(source.bugfixMd) : undefined,
    // Carry the raw artifact text verbatim alongside the parsed model: the Design
    // viewer flips to it one keystroke away, never a re-serialization.
    raw: {
      ...(source.requirementsMd !== undefined ? { requirementsMd: source.requirementsMd } : {}),
      ...(source.designMd !== undefined ? { designMd: source.designMd } : {}),
      ...(source.tasksMd !== undefined ? { tasksMd: source.tasksMd } : {}),
      ...(source.bugfixMd !== undefined ? { bugfixMd: source.bugfixMd } : {}),
    },
  };
}
