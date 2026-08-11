import type {
  OpenSpecArtifact,
  OpenSpecBlock,
  OpenSpecCapabilityNote,
  OpenSpecChange,
  OpenSpecDeltaOperation,
  OpenSpecDesign,
  OpenSpecDesignSection,
  OpenSpecImpactEntry,
  OpenSpecListItem,
  OpenSpecProposal,
  OpenSpecRequirement,
  OpenSpecRequirementGroup,
  OpenSpecScenario,
  OpenSpecScenarioKeyword,
  OpenSpecScenarioStep,
  OpenSpecSource,
  OpenSpecSpecDelta,
  OpenSpecTaskGroup,
  OpenSpecTaskItem,
  OpenSpecTasks,
} from "@rennet/types";

/**
 * The source-origin base for a run of lines handed to `parseBlocks`: which
 * artifact they came from and the 1-based file line of the FIRST line in the run.
 * A node's `source.line` is `baseLine + itsLocalIndex`, so every reviewable node
 * carries the real artifact file + line a durable disposition anchors to.
 */
interface SourceBase {
  readonly artifact: OpenSpecArtifact;
  readonly capability?: string;
  /** 1-based file line of `lines[0]` in the slice being parsed. */
  readonly baseLine: number;
}

/** Build a node source from a base + the node's local (0-based) offset in the slice. */
function sourceAt(base: SourceBase | undefined, localIndex: number): OpenSpecSource | undefined {
  if (!base) return undefined;
  return base.capability !== undefined
    ? { artifact: base.artifact, capability: base.capability, line: base.baseLine + localIndex }
    : { artifact: base.artifact, line: base.baseLine + localIndex };
}

/**
 * Parse an OpenSpec change's markdown artifacts into a STRUCTURED model.
 *
 * An OpenSpec change ships a fixed, known set of artifacts — a `proposal.md`, a
 * `design.md`, a `tasks.md`, and per-capability spec deltas — and each has a known
 * shape. Because the shape is known ahead of time, the Spec angle renders it
 * structured (requirement/scenario tree, task checklist + progress, capabilities,
 * spec deltas as structured diffs) rather than dumping the raw markdown. This
 * module is that parser: it is node-free (pure string work, no fs), so the reader
 * is a plain function of the artifact text and every rule is unit-testable.
 *
 * The parser is deliberately tolerant: any artifact may be absent, sections may be
 * missing or empty, and the whole-change roll-up counts only what is present. It
 * never throws on well-formed-but-sparse input; a change with only a `proposal.md`
 * parses to a change whose `design`/`tasks` are absent and whose `specDeltas` is
 * empty.
 */

/** The raw artifact text for one OpenSpec change (what an adapter reads off disk). */
export interface OpenSpecChangeSource {
  /** The change directory name. */
  readonly name: string;
  readonly proposalMd?: string;
  readonly designMd?: string;
  readonly tasksMd?: string;
  /** Per-capability spec-delta files (`specs/<capability>/spec.md`). */
  readonly specDeltas?: readonly { readonly capability: string; readonly md: string }[];
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
 * The artifacts lean on the `**Lead.** the rest…` idiom; pulling the lead out lets
 * the surface emphasise it. When there is no leading bold, the whole line is the
 * text and there is no lead.
 */
function splitListItem(body: string, source: OpenSpecSource | undefined): OpenSpecListItem {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(body);
  if (bold) {
    const lead = (bold[1] ?? "").trim();
    const rest = (bold[2] ?? "").replace(/^[—–:-]\s*/, "").trim();
    // A wholly-bold item (no remainder) reads better as plain text than as an
    // orphan lead with an empty body.
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
 * Walk a block of lines into ordered rendered blocks: paragraphs, lists, fenced
 * code, and tables. A blank line separates blocks; a `---` rule is dropped. This is
 * the shared renderer for design sections and the proposal's prose sections.
 */
function parseBlocks(lines: readonly string[], base?: SourceBase): OpenSpecBlock[] {
  const blocks: OpenSpecBlock[] = [];
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

    // List (a run of consecutive marker lines; a continuation line indented under
    // an item is folded into it).
    if (LIST_MARKER.test(line)) {
      const items: OpenSpecListItem[] = [];
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
 * The lines OWNED by a heading, stopping at the NEXT heading of ANY level (not
 * just level ≤ its own). A parent `##` therefore ends where its first `###` child
 * begins, so a nested-section document renders each heading exactly once — the
 * child's prose belongs to the child, never duplicated into the parent's body.
 * (`sectionBody` deliberately nests; this one deliberately does not.)
 */
function ownBody(lines: readonly string[], headings: readonly Heading[], index: number): string[] {
  const heading = headings[index];
  if (!heading) return [];
  const next = headings[index + 1];
  const end = next ? next.line : lines.length;
  return lines.slice(heading.line + 1, end);
}

// ── proposal.md ──────────────────────────────────────────────────────────────

/** The source base for a heading's body: its artifact + the 1-based line of the first body line. */
function bodyBase(
  headings: readonly Heading[],
  index: number,
  artifact: OpenSpecArtifact,
  capability?: string,
): SourceBase | undefined {
  const heading = headings[index];
  if (!heading) return undefined;
  return capability !== undefined
    ? { artifact, capability, baseLine: heading.line + 2 }
    : { artifact, baseLine: heading.line + 2 };
}

/** Parse a Capabilities subsection's bullets into named capability notes. */
function parseCapabilityNotes(
  lines: readonly string[],
  base: SourceBase | undefined,
): OpenSpecCapabilityNote[] {
  const notes: OpenSpecCapabilityNote[] = [];
  for (const block of parseBlocks(lines, base)) {
    if (block.kind !== "list") continue;
    for (const item of block.items) {
      const whole = item.lead ? `${item.lead} ${item.text}` : item.text;
      const source = item.source;
      const backticked = /^`([^`]+)`\s*[:—–-]?\s*(.*)$/.exec(whole);
      if (backticked) {
        const note: OpenSpecCapabilityNote = {
          name: (backticked[1] ?? "").trim(),
          summary: (backticked[2] ?? "").trim(),
          ...(source ? { source } : {}),
        };
        notes.push(note);
        continue;
      }
      const colon = whole.indexOf(":");
      if (colon > 0) {
        notes.push({
          name: whole.slice(0, colon).trim(),
          summary: whole.slice(colon + 1).trim(),
          ...(source ? { source } : {}),
        });
      } else {
        notes.push({ name: whole.trim(), summary: "", ...(source ? { source } : {}) });
      }
    }
  }
  return notes;
}

/** Strip inline code/emphasis markers from a short label (an impact area). */
function plainLabel(text: string): string {
  return text.replace(/[`*]/g, "").trim();
}

function parseProposal(md: string): OpenSpecProposal {
  const lines = toLines(md);
  const headings = findHeadings(lines);

  const bySection = (predicate: (text: string) => boolean, level = 2): number =>
    headings.findIndex((h) => h.level === level && predicate(h.text.toLowerCase()));

  const whyIdx = bySection((t) => t.startsWith("why"));
  const whatIdx = bySection((t) => t.includes("what changes"));
  const capsIdx = bySection((t) => t.startsWith("capabilities"));
  const impactIdx = bySection((t) => t.startsWith("impact"));

  const why =
    whyIdx >= 0
      ? parseBlocks(sectionBody(lines, headings, whyIdx), bodyBase(headings, whyIdx, "proposal"))
      : [];

  const whatChanges: OpenSpecListItem[] = [];
  if (whatIdx >= 0) {
    for (const block of parseBlocks(
      sectionBody(lines, headings, whatIdx),
      bodyBase(headings, whatIdx, "proposal"),
    )) {
      if (block.kind === "list") whatChanges.push(...block.items);
    }
  }

  let newCapabilities: OpenSpecCapabilityNote[] = [];
  let modifiedCapabilities: OpenSpecCapabilityNote[] = [];
  if (capsIdx >= 0) {
    const newIdx = headings.findIndex(
      (h, idx) => idx > capsIdx && h.level === 3 && h.text.toLowerCase().includes("new"),
    );
    const modIdx = headings.findIndex(
      (h, idx) => idx > capsIdx && h.level === 3 && h.text.toLowerCase().includes("modif"),
    );
    if (newIdx >= 0)
      newCapabilities = parseCapabilityNotes(
        sectionBody(lines, headings, newIdx),
        bodyBase(headings, newIdx, "proposal"),
      );
    if (modIdx >= 0) {
      modifiedCapabilities = parseCapabilityNotes(
        sectionBody(lines, headings, modIdx),
        bodyBase(headings, modIdx, "proposal"),
      );
    }
    // A Capabilities section with no New/Modified subsections: read its own bullets as new.
    if (newIdx < 0 && modIdx < 0) {
      newCapabilities = parseCapabilityNotes(
        sectionBody(lines, headings, capsIdx),
        bodyBase(headings, capsIdx, "proposal"),
      );
    }
  }

  const impact: OpenSpecImpactEntry[] = [];
  if (impactIdx >= 0) {
    for (const block of parseBlocks(sectionBody(lines, headings, impactIdx))) {
      if (block.kind !== "list") continue;
      for (const item of block.items) {
        if (item.lead) {
          impact.push({ area: plainLabel(item.lead), detail: item.text });
        } else {
          // No bold lead: split on the first dash/colon so the area is still named.
          const split = /^(.*?)\s*[—–:-]\s+(.*)$/.exec(item.text);
          if (split)
            impact.push({ area: plainLabel(split[1] ?? ""), detail: (split[2] ?? "").trim() });
          else impact.push({ area: "", detail: item.text });
        }
      }
    }
  }

  return { why, whatChanges, newCapabilities, modifiedCapabilities, impact };
}

// ── design.md ────────────────────────────────────────────────────────────────

function parseDesign(md: string): OpenSpecDesign {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const sections: OpenSpecDesignSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading) continue;
    // The `#` title is the doc's name, not a section; the tree is `##`/`###`.
    if (heading.level < 2 || heading.level > 3) continue;
    sections.push({
      id: slugify(heading.text),
      level: heading.level as 2 | 3,
      heading: heading.text,
      // `ownBody`, not `sectionBody`: a `##` section stops at its first `###`
      // child, so nested headings render once (no duplicated child prose).
      blocks: parseBlocks(ownBody(lines, headings, i), bodyBase(headings, i, "design")),
      source: { artifact: "design", line: heading.line + 1 },
    });
  }
  return { sections };
}

// ── tasks.md ─────────────────────────────────────────────────────────────────

const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

/** `headingLine` is the group heading's 0-based line; body lines start at `headingLine + 1`. */
function parseTaskGroup(
  title: string,
  lines: readonly string[],
  headingLine: number,
): OpenSpecTaskGroup {
  const items: OpenSpecTaskItem[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = TASK_ITEM.exec(lines[i] ?? "");
    if (!match) continue;
    const status = (match[1] ?? "").toLowerCase() === "x" ? "done" : "todo";
    // Body line i is 0-based within the slice; its 1-based file line is
    // headingLine + 1 (first body line) + i.
    items.push({
      text: (match[2] ?? "").trim(),
      status,
      source: { artifact: "tasks", line: headingLine + 2 + i },
    });
  }
  const done = items.filter((item) => item.status === "done").length;
  return {
    id: slugify(title),
    title,
    items,
    total: items.length,
    done,
    source: { artifact: "tasks", line: headingLine + 1 },
  };
}

function parseTasks(md: string): OpenSpecTasks {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const groups: OpenSpecTaskGroup[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (heading?.level !== 2) continue;
    const group = parseTaskGroup(heading.text, sectionBody(lines, headings, i), heading.line);
    // Keep only groups that actually carry checklist items.
    if (group.items.length > 0) groups.push(group);
  }
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const done = groups.reduce((sum, group) => sum + group.done, 0);
  return { groups, total, done };
}

// ── spec deltas ──────────────────────────────────────────────────────────────

const DELTA_OPERATIONS: Record<string, OpenSpecDeltaOperation> = {
  added: "added",
  modified: "modified",
  removed: "removed",
  renamed: "renamed",
};

const SCENARIO_STEP = /^\s*[-*]\s+\*\*(WHEN|THEN|AND|GIVEN)\*\*\s*(.*)$/i;

function parseScenario(
  name: string,
  lines: readonly string[],
  source: OpenSpecSource,
): OpenSpecScenario {
  const steps: OpenSpecScenarioStep[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = SCENARIO_STEP.exec(lines[i] ?? "");
    if (!match) continue;
    const keyword = (match[1] ?? "").toLowerCase() as OpenSpecScenarioKeyword;
    let text = (match[2] ?? "").trim();
    // Fold a plain continuation line into the step.
    while (i + 1 < lines.length) {
      const cont = lines[i + 1] ?? "";
      if (cont.trim().length === 0 || SCENARIO_STEP.test(cont) || /^\s*#{1,6}\s/.test(cont)) break;
      text += ` ${cont.trim()}`;
      i += 1;
    }
    steps.push({ keyword, text });
  }
  return { name, steps, source };
}

function parseRequirement(
  name: string,
  lines: readonly string[],
  headings: readonly Heading[],
  reqIndex: number,
  capability: string,
): OpenSpecRequirement {
  const reqHeading = headings[reqIndex];
  const specSource = (line: number): OpenSpecSource => ({ artifact: "spec", capability, line });
  if (!reqHeading) return { name, statement: "", scenarios: [], source: specSource(1) };

  // Statement = the prose between the requirement heading and its first scenario.
  const scenarioHeadings = headings.filter(
    (h) => h.level === 4 && /^scenario:/i.test(h.text) && h.line > reqHeading.line,
  );
  const nextReq = headings.slice(reqIndex + 1).find((h) => h.level <= 3);
  const reqEnd = nextReq ? nextReq.line : Number.POSITIVE_INFINITY;
  const ownScenarios = scenarioHeadings.filter((h) => h.line < reqEnd);

  const firstScenario = ownScenarios[0];
  const statementEnd = firstScenario ? firstScenario.line : Math.min(reqEnd, lines.length);
  const statementLines = lines.slice(reqHeading.line + 1, statementEnd);
  const statement = parseBlocks(statementLines)
    .filter(
      (block): block is Extract<OpenSpecBlock, { kind: "paragraph" }> => block.kind === "paragraph",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();

  const scenarios: OpenSpecScenario[] = ownScenarios.map((heading) => {
    const idx = headings.indexOf(heading);
    const body = sectionBody(lines, headings, idx);
    const scenarioName = heading.text.replace(/^scenario:\s*/i, "").trim();
    return parseScenario(scenarioName, body, specSource(heading.line + 1));
  });

  return { name, statement, scenarios, source: specSource(reqHeading.line + 1) };
}

function parseSpecDelta(capability: string, md: string): OpenSpecSpecDelta {
  const lines = toLines(md);
  const headings = findHeadings(lines);
  const groups: OpenSpecRequirementGroup[] = [];

  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (heading?.level !== 2) continue;
    const opMatch = /^(added|modified|removed|renamed)\b/i.exec(heading.text.trim());
    if (!opMatch) continue;
    const operation = DELTA_OPERATIONS[(opMatch[1] ?? "").toLowerCase()];
    if (!operation) continue;

    // The requirement headings under this operation (level-3 `Requirement:`).
    const opEnd = headings.slice(i + 1).find((h) => h.level === 2);
    const opEndLine = opEnd ? opEnd.line : lines.length;
    const requirements: OpenSpecRequirement[] = [];
    for (let j = i + 1; j < headings.length; j += 1) {
      const req = headings[j];
      if (!req || req.line >= opEndLine) break;
      if (req.level !== 3 || !/^requirement:/i.test(req.text)) continue;
      const reqName = req.text.replace(/^requirement:\s*/i, "").trim();
      requirements.push(parseRequirement(reqName, lines, headings, j, capability));
    }
    groups.push({ operation, requirements });
  }

  return { capability, groups, source: { artifact: "spec", capability, line: 1 } };
}

/**
 * Parse a whole OpenSpec change's artifact text into the structured model the Spec
 * angle renders. Absent artifacts are simply absent on the result; `specDeltas` is
 * empty (never absent) when no spec files were supplied.
 */
export function parseOpenSpecChange(source: OpenSpecChangeSource): OpenSpecChange {
  const specDeltas = (source.specDeltas ?? []).map((delta) =>
    parseSpecDelta(delta.capability, delta.md),
  );
  return {
    name: source.name,
    proposal: source.proposalMd !== undefined ? parseProposal(source.proposalMd) : undefined,
    design: source.designMd !== undefined ? parseDesign(source.designMd) : undefined,
    tasks: source.tasksMd !== undefined ? parseTasks(source.tasksMd) : undefined,
    specDeltas,
  };
}
