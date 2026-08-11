import type {
  OpenSpecCapabilityDelta,
  OpenSpecCapabilityDeltaKind,
  OpenSpecChange,
  OpenSpecChangeMeta,
  OpenSpecDeltaGroup,
  OpenSpecDeltaOperation,
  OpenSpecDesign,
  OpenSpecProposal,
  OpenSpecProseSection,
  OpenSpecRequirement,
  OpenSpecReviewAnchor,
  OpenSpecScenario,
  OpenSpecScenarioStep,
  OpenSpecSpecDelta,
  OpenSpecTaskGroup,
  OpenSpecTaskItem,
  OpenSpecTasks,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// parseOpenSpecChange — the node-free pure parser that turns the raw markdown of
// one `openspec/changes/<name>/` set (proposal + optional design + tasks +
// per-capability spec deltas) into the structured `OpenSpecChange` view model.
//
// The adapter that walks the filesystem hands the file CONTENTS here as strings;
// this module reads nothing (`layer:core` never imports Node). Parsing is line-
// based and forgiving: a missing canonical section becomes an EMPTY section, never
// a throw, so a partially-written change still renders. Every node is stamped with
// a structural `OpenSpecReviewAnchor` (`id = ${artifact}:${path}`) as it is built,
// so the viewer can pin a review comment to any node and have it survive a re-parse.
// ─────────────────────────────────────────────────────────────────────────────

/** One `specs/<capability>/spec.md` file: the capability name + its raw markdown. */
export interface RawOpenSpecSpecFile {
  readonly capability: string;
  readonly markdown: string;
}

/** The raw file contents of one change, as the fs adapter reads them. */
export interface RawOpenSpecChange {
  /** The change directory name (its identifier). */
  readonly name: string;
  /** The `.openspec.yaml` sidecar content, if present. */
  readonly openspecYaml?: string;
  /** `proposal.md` content. */
  readonly proposal: string;
  /** `design.md` content, if present. */
  readonly design?: string;
  /** `tasks.md` content. */
  readonly tasks: string;
  /** The `specs/<capability>/spec.md` set, if present. */
  readonly specs?: readonly RawOpenSpecSpecFile[];
}

// ── small markdown primitives ─────────────────────────────────────────────────

interface Heading {
  readonly level: number;
  readonly text: string;
  /** 0-based line index of the heading. */
  readonly line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** Split into lines, normalising CRLF. */
function toLines(md: string): string[] {
  return md.replace(/\r\n?/g, "\n").split("\n");
}

/** All ATX headings, ignoring any inside a fenced code block (so `# comment` in a shell snippet is not a heading). */
function headingsOf(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (match) out.push({ level: (match[1] ?? "").length, text: (match[2] ?? "").trim(), line: i });
  }
  return out;
}

/** The body between two line indices (exclusive of the heading line), trimmed. */
function bodyBetween(lines: readonly string[], fromExclusive: number, toExclusive: number): string {
  return lines
    .slice(fromExclusive + 1, toExclusive)
    .join("\n")
    .trim();
}

const anchorOf = (
  artifact: OpenSpecReviewAnchor["artifact"],
  path: string,
  label?: string,
): OpenSpecReviewAnchor => ({
  id: `${artifact}:${path}`,
  artifact,
  path,
  ...(label ? { label } : {}),
});

const joinPath = (prefix: string, segment: string): string =>
  prefix ? `${prefix}/${segment}` : segment;

/** Normalise a heading for matching (lower-case, collapse whitespace). */
const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

// ── prose section tree (used for design and the proposal's plain sections) ────

/**
 * Parse the sections at exactly `level` within `[start, end)` into a prose tree.
 * A section's lead `body` is the prose between its heading and its first child
 * heading (level + 1); deeper headings become nested `subsections`. `pathPrefix`
 * seeds the structural anchor path; sections are indexed in document order.
 */
function parseSectionTree(
  lines: readonly string[],
  all: readonly Heading[],
  start: number,
  end: number,
  level: number,
  artifact: OpenSpecReviewAnchor["artifact"],
  pathPrefix: string,
): OpenSpecProseSection[] {
  const heads = all.filter((h) => h.line >= start && h.line < end && h.level === level);
  return heads.map((head, index) => {
    // The section runs until the next heading of level <= this one, within range.
    const next = all.find((h) => h.line > head.line && h.line < end && h.level <= level);
    const sectionEnd = next ? next.line : end;
    const firstChild = all.find(
      (h) => h.line > head.line && h.line < sectionEnd && h.level === level + 1,
    );
    const bodyEnd = firstChild ? firstChild.line : sectionEnd;
    const path = joinPath(pathPrefix, String(index));
    const subsections = parseSectionTree(
      lines,
      all,
      head.line + 1,
      sectionEnd,
      level + 1,
      artifact,
      path,
    );
    return {
      heading: head.text,
      level,
      body: bodyBetween(lines, head.line, bodyEnd),
      anchor: anchorOf(artifact, path, head.text),
      ...(subsections.length > 0 ? { subsections } : {}),
    };
  });
}

// ── meta (.openspec.yaml) ─────────────────────────────────────────────────────

const scalar = (yaml: string, key: string): string | undefined => {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(yaml);
  if (!match) return undefined;
  return (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
};

function parseMeta(yaml: string | undefined): OpenSpecChangeMeta | undefined {
  if (!yaml) return undefined;
  const schema = scalar(yaml, "schema");
  const created = scalar(yaml, "created");
  if (schema === undefined && created === undefined) return undefined;
  return { ...(schema ? { schema } : {}), ...(created ? { created } : {}) };
}

// ── proposal.md ───────────────────────────────────────────────────────────────

const BULLET_RE = /^-\s+(.*)$/;
const CAP_KIND: Record<string, OpenSpecCapabilityDeltaKind> = {
  new: "new",
  added: "new",
  modified: "modified",
  changed: "modified",
  removed: "removed",
};

/** Parse one `## Capabilities` sub-heading's `- ` bullets into capability deltas. */
function parseCapabilityBullets(
  lines: readonly string[],
  from: number,
  to: number,
  kind: OpenSpecCapabilityDeltaKind,
  startIndex: number,
): OpenSpecCapabilityDelta[] {
  const out: OpenSpecCapabilityDelta[] = [];
  for (let i = from; i < to; i++) {
    const match = BULLET_RE.exec(lines[i] ?? "");
    if (!match) continue;
    const content = (match[1] ?? "").trim();
    const colon = content.indexOf(":");
    const rawName = colon >= 0 ? content.slice(0, colon) : content;
    const description = colon >= 0 ? content.slice(colon + 1).trim() : "";
    const name = rawName.replace(/[`*]/g, "").trim();
    const index = startIndex + out.length;
    out.push({
      kind,
      name,
      description,
      anchor: anchorOf("proposal", `capabilities/${index}`, name),
    });
  }
  return out;
}

function parseProposal(md: string): OpenSpecProposal {
  const lines = toLines(md);
  const all = headingsOf(lines);
  const sections = parseSectionTree(lines, all, 0, lines.length, 2, "proposal", "");

  const emptyProse = (heading: string, pathSeg: string): OpenSpecProseSection => ({
    heading,
    level: 2,
    body: "",
    anchor: anchorOf("proposal", pathSeg, heading),
  });

  let why = emptyProse("Why", "why");
  let whatChanges = emptyProse("What Changes", "whatChanges");
  let impact = emptyProse("Impact", "impact");
  const capabilities: OpenSpecCapabilityDelta[] = [];
  const extraSections: OpenSpecProseSection[] = [];

  for (const section of sections) {
    const key = norm(section.heading);
    if (key === "why") {
      why = { ...section, anchor: anchorOf("proposal", "why", section.heading) };
    } else if (key === "what changes") {
      whatChanges = { ...section, anchor: anchorOf("proposal", "whatChanges", section.heading) };
    } else if (key === "impact") {
      impact = { ...section, anchor: anchorOf("proposal", "impact", section.heading) };
    } else if (key === "capabilities") {
      // Each `### <kind> Capabilities` sub-heading contributes its bullets.
      const sectionHead = all.find((h) => h.level === 2 && h.text.trim() === section.heading);
      const sectionStart = sectionHead ? sectionHead.line : 0;
      const nextTop = all.find((h) => h.line > sectionStart && h.level <= 2);
      const sectionEnd = nextTop ? nextTop.line : lines.length;
      const subHeads = all.filter(
        (h) => h.line > sectionStart && h.line < sectionEnd && h.level === 3,
      );
      for (const sub of subHeads) {
        const kindWord = norm(sub.text).split(" ")[0] ?? "";
        const kind = CAP_KIND[kindWord];
        if (!kind) continue;
        const subNext = all.find((h) => h.line > sub.line && h.line < sectionEnd && h.level <= 3);
        const subEnd = subNext ? subNext.line : sectionEnd;
        capabilities.push(
          ...parseCapabilityBullets(lines, sub.line + 1, subEnd, kind, capabilities.length),
        );
      }
    } else {
      extraSections.push(section);
    }
  }

  return {
    why,
    whatChanges,
    capabilities,
    impact,
    anchor: anchorOf("proposal", "", "Proposal"),
    ...(extraSections.length > 0 ? { extraSections } : {}),
  };
}

// ── design.md ─────────────────────────────────────────────────────────────────

function parseDesign(md: string | undefined): OpenSpecDesign | undefined {
  if (md === undefined) return undefined;
  const lines = toLines(md);
  const all = headingsOf(lines);
  // design.md opens with a `# Design` H1; its `##` sections are the content.
  const topLevel = all.some((h) => h.level === 1) ? 2 : Math.min(...all.map((h) => h.level), 2);
  const sections = parseSectionTree(lines, all, 0, lines.length, topLevel, "design", "");
  return { sections, anchor: anchorOf("design", "", "Design") };
}

// ── tasks.md ──────────────────────────────────────────────────────────────────

const GROUP_RE = /^##\s+(?:(\d+)\.\s+)?(.*)$/;
const ITEM_RE = /^-\s+\[([ xX])\]\s+(.*)$/;
const ORDINAL_RE = /^(\d+(?:\.\d+)*)\s+(.*)$/;

function parseTasks(md: string): OpenSpecTasks {
  const lines = toLines(md);
  const all = headingsOf(lines);
  const groupHeads = all.filter((h) => h.level === 2);
  const groups: OpenSpecTaskGroup[] = [];
  let total = 0;
  let completed = 0;

  groupHeads.forEach((head, groupIndex) => {
    const next = all.find((h) => h.line > head.line && h.level <= 2);
    const end = next ? next.line : lines.length;
    const groupMatch = GROUP_RE.exec(lines[head.line] ?? "");
    const ordinal = groupMatch?.[1];
    const title = (groupMatch?.[2] ?? head.text).trim();
    const groupPath = `groups/${groupIndex}`;
    const items: OpenSpecTaskItem[] = [];
    for (let i = head.line + 1; i < end; i++) {
      const itemMatch = ITEM_RE.exec(lines[i] ?? "");
      if (!itemMatch) continue;
      const checked = (itemMatch[1] ?? "").toLowerCase() === "x";
      const rest = (itemMatch[2] ?? "").trim();
      const ordMatch = ORDINAL_RE.exec(rest);
      const itemOrdinal = ordMatch?.[1];
      const text = (ordMatch?.[2] ?? rest).trim();
      const itemPath = `${groupPath}/items/${items.length}`;
      items.push({
        ...(itemOrdinal ? { ordinal: itemOrdinal } : {}),
        text,
        checked,
        anchor: anchorOf("tasks", itemPath, itemOrdinal ?? text),
      });
      total += 1;
      if (checked) completed += 1;
    }
    groups.push({
      ...(ordinal ? { ordinal } : {}),
      title,
      items,
      anchor: anchorOf("tasks", groupPath, ordinal ? `${ordinal}. ${title}` : title),
    });
  });

  return { groups, total, completed, anchor: anchorOf("tasks", "", "Tasks") };
}

// ── spec deltas (specs/<capability>/spec.md) ──────────────────────────────────

const OP_RE = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;
const REQ_RE = /^###\s+Requirement:\s*(.*)$/;
const SCENARIO_RE = /^####\s+Scenario:\s*(.*)$/;
const STEP_RE = /^-\s+(?:\*\*([A-Za-z]+)\*\*\s*)?(.*)$/;

function parseScenarioSteps(
  lines: readonly string[],
  from: number,
  to: number,
): OpenSpecScenarioStep[] {
  const steps: OpenSpecScenarioStep[] = [];
  for (let i = from; i < to; i++) {
    const match = STEP_RE.exec(lines[i] ?? "");
    if (!match) continue;
    const keyword = match[1] ? match[1].toUpperCase() : undefined;
    const text = (match[2] ?? "").trim();
    if (!keyword && text.length === 0) continue;
    steps.push({ ...(keyword ? { keyword } : {}), text });
  }
  return steps;
}

function parseSpecDelta(file: RawOpenSpecSpecFile): OpenSpecSpecDelta {
  const lines = toLines(file.markdown);
  const all = headingsOf(lines);
  const capPath = file.capability;

  // Intro: any prose before the first `## <OP> Requirements` heading (skip the H1).
  const firstOp = all.find((h) => OP_RE.test(lines[h.line] ?? ""));
  const firstH1 = all.find((h) => h.level === 1);
  const introFrom = firstH1 ? firstH1.line : -1;
  const introTo = firstOp ? firstOp.line : lines.length;
  const intro = bodyBetween(lines, introFrom, introTo) || undefined;

  const opHeads = all.filter((h) => OP_RE.test(lines[h.line] ?? ""));
  const operations: OpenSpecDeltaGroup[] = [];
  let requirementCount = 0;

  opHeads.forEach((opHead, opIndex) => {
    const opMatch = OP_RE.exec(lines[opHead.line] ?? "");
    const operation = (opMatch?.[1] ?? "added").toLowerCase() as OpenSpecDeltaOperation;
    const opNext = all.find((h) => h.line > opHead.line && h.level <= 2);
    const opEnd = opNext ? opNext.line : lines.length;
    const opPath = joinPath(capPath, `operations/${opIndex}`);

    const reqHeads = all.filter(
      (h) =>
        h.line > opHead.line && h.line < opEnd && h.level === 3 && REQ_RE.test(lines[h.line] ?? ""),
    );
    const requirements: OpenSpecRequirement[] = reqHeads.map((reqHead, reqIndex) => {
      const name = (REQ_RE.exec(lines[reqHead.line] ?? "")?.[1] ?? reqHead.text).trim();
      const reqNext = all.find((h) => h.line > reqHead.line && h.line < opEnd && h.level <= 3);
      const reqEnd = reqNext ? reqNext.line : opEnd;
      const scenHeads = all.filter(
        (h) =>
          h.line > reqHead.line &&
          h.line < reqEnd &&
          h.level === 4 &&
          SCENARIO_RE.test(lines[h.line] ?? ""),
      );
      const firstScen = scenHeads[0];
      const bodyEnd = firstScen ? firstScen.line : reqEnd;
      const reqPath = joinPath(opPath, `requirements/${reqIndex}`);
      const scenarios: OpenSpecScenario[] = scenHeads.map((scenHead, scenIndex) => {
        const scenName = (
          SCENARIO_RE.exec(lines[scenHead.line] ?? "")?.[1] ?? scenHead.text
        ).trim();
        const scenNext = all.find((h) => h.line > scenHead.line && h.line < reqEnd && h.level <= 4);
        const scenEnd = scenNext ? scenNext.line : reqEnd;
        const scenPath = joinPath(reqPath, `scenarios/${scenIndex}`);
        return {
          name: scenName,
          steps: parseScenarioSteps(lines, scenHead.line + 1, scenEnd),
          anchor: anchorOf("spec", scenPath, scenName),
        };
      });
      requirementCount += 1;
      return {
        name,
        text: bodyBetween(lines, reqHead.line, bodyEnd),
        scenarios,
        anchor: anchorOf("spec", reqPath, name),
      };
    });

    operations.push({ operation, requirements, anchor: anchorOf("spec", opPath, operation) });
  });

  return {
    capability: file.capability,
    ...(intro ? { intro } : {}),
    operations,
    requirementCount,
    anchor: anchorOf("spec", capPath, file.capability),
  };
}

// ── the whole change ──────────────────────────────────────────────────────────

/**
 * Parse the raw markdown of one `openspec/changes/<name>/` set into the structured,
 * review-anchored `OpenSpecChange`. Pure and node-free: pass the file contents in,
 * get the model out. Forgiving by design — a missing canonical proposal section is
 * an empty section, an absent design or spec set is simply omitted — so a partial
 * change still parses and renders.
 */
export function parseOpenSpecChange(raw: RawOpenSpecChange): OpenSpecChange {
  const meta = parseMeta(raw.openspecYaml);
  const design = parseDesign(raw.design);
  const specDeltas = (raw.specs ?? []).map(parseSpecDelta);
  return {
    name: raw.name,
    ...(meta ? { meta } : {}),
    proposal: parseProposal(raw.proposal),
    ...(design ? { design } : {}),
    tasks: parseTasks(raw.tasks),
    specDeltas,
  };
}
