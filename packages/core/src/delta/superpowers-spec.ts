import type {
  SuperpowersArtifact,
  SuperpowersDesignSection,
  SuperpowersDesignSpec,
  SuperpowersPlan,
  SuperpowersPlanDecision,
  SuperpowersPlanStep,
  SuperpowersProgressEntry,
  SuperpowersProgressLedger,
  SuperpowersProgressMarker,
  SuperpowersSource,
  SuperpowersSpec,
  SuperpowersTaskGroup,
  SuperpowersTaskManifest,
} from "@rennet/protocol";

/**
 * Parse a Superpowers feature's markdown artifacts into a STRUCTURED model.
 *
 * A Superpowers feature ships a fixed, known set of artifacts — a design SPEC
 * (`docs/superpowers/specs/<feature>.md`), an execution PLAN with a file-and-
 * verification manifest (`docs/superpowers/plans/<date>-<feature>.md`), and a
 * PROGRESS ledger that binds to a plan (`.superpowers/sdd/<feature>/progress.md`).
 * Because the shape is known ahead of time, the Design angle renders it structured
 * (task groups with per-task manifests, plan-header choices, a plan-vs-progress
 * completion state) rather than dumping the raw markdown. This module is that parser:
 * it is node-free (pure string work, no fs), so the reader is a plain function of the
 * artifact text and every rule is unit-testable.
 *
 * The parser is deliberately tolerant: any artifact may be absent, sections may be
 * missing or empty, and the whole-feature roll-up counts only what is present. It
 * never throws on well-formed-but-sparse input; a feature with only a plan parses to
 * one whose `specs`/`progressLedgers` are empty (never absent).
 *
 * This mirrors `parseOpenSpecChange` in structure, style, and rigor — the regexes it
 * uses match the ones `packages/core/src/board/design-obligations.ts` already applies
 * to the same source text (`parseSuperpowersTaskManifest`, `superpowersProgressMarker`,
 * `parseSuperpowersPlanChoices`), so the rich model and the lint obligations agree on
 * what a Superpowers plan/ledger says.
 */

/** One artifact's path + raw text (what an adapter reads off disk). */
interface SuperpowersArtifactText {
  readonly path: string;
  readonly md: string;
}

/** The raw artifact text for one Superpowers feature. */
export interface SuperpowersSpecSource {
  /** A display name for the feature (the reader derives it from the plan/spec stem). */
  readonly name: string;
  readonly specs?: readonly SuperpowersArtifactText[];
  readonly plans?: readonly SuperpowersArtifactText[];
  readonly progress?: readonly SuperpowersArtifactText[];
}

/** Split into lines, tolerating CRLF, with no trailing carriage returns. */
function toLines(md: string): string[] {
  return md.replace(/\r\n?/g, "\n").split("\n");
}

/** True for the opening/closing of a fenced code block. */
function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** True for a `---`/`***`/`___` horizontal rule. */
function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])\1{2,}\s*$/.test(line);
}

const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/;
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

/** A heading match: its level, its trimmed text, and its 0-based line index. */
interface Heading {
  readonly level: number;
  readonly text: string;
  readonly index: number;
}

/** Headings outside fenced code (a `#` inside a fence is a code comment, not a heading). */
function findHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING.exec(line);
    if (match)
      headings.push({ level: (match[1] ?? "").length, text: (match[2] ?? "").trim(), index });
  }
  return headings;
}

/** The 0-based line where `heading`'s section ends: the next heading of level ≤ its own. */
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

/** Collapse a run of prose lines to one string, dropping headings, rules, and fenced code. */
function flattenProse(lines: readonly string[], start: number, end: number): string {
  const kept: string[] = [];
  let inFence = false;
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0 || HEADING.test(line) || isHorizontalRule(line)) continue;
    kept.push(trimmed);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** A URL/anchor slug from a heading (lowercase, non-alphanumerics collapsed to `-`). */
function slugify(heading: string): string {
  const value = heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value.length > 0 ? value : "untitled";
}

/** Build a node source (artifact + path + 1-based line). */
function sourceAt(artifact: SuperpowersArtifact, path: string, line: number): SuperpowersSource {
  return { artifact, path, line };
}

// ── design spec (docs/superpowers/specs/**) ──────────────────────────────────

function parseDesignSpec(artifact: SuperpowersArtifactText): SuperpowersDesignSpec {
  const lines = toLines(artifact.md);
  const headings = findHeadings(lines);
  const sections: SuperpowersDesignSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading) continue;
    // The `#` title is the doc's name; the tree is `##`/`###`.
    if (heading.level < 2 || heading.level > 3) continue;
    const next = headings[i + 1];
    const bodyEnd = next ? next.index : lines.length;
    sections.push({
      id: slugify(heading.text),
      level: heading.level as 2 | 3,
      heading: heading.text,
      body: flattenProse(lines, heading.index + 1, bodyEnd),
      source: sourceAt("spec", artifact.path, heading.index + 1),
    });
  }
  return { path: artifact.path, sections };
}

// ── plan (docs/superpowers/plans/**) ─────────────────────────────────────────

const TASK_HEADING = /^Task\s+(\d+(?:\.\d+)*)\s*:/i;

/** Parse the file/interface/verification manifest lines in `[start, end)`. */
function parseTaskManifest(
  lines: readonly string[],
  start: number,
  end: number,
): SuperpowersTaskManifest {
  const files: SuperpowersTaskManifest["files"][number][] = [];
  const interfaces: SuperpowersTaskManifest["interfaces"][number][] = [];
  const verifications: SuperpowersTaskManifest["verifications"][number][] = [];
  let run: string | undefined;

  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    const file = /^\s*[-*+]\s+(Create|Modify|Test):\s*(.+?)\s*$/i.exec(line);
    if (file !== null) {
      const operation = (file[1] ?? "").toLowerCase();
      if (operation === "create" || operation === "modify" || operation === "test") {
        files.push({ operation, value: (file[2] ?? "").trim() });
      }
      continue;
    }
    const contract = /^\s*[-*+]\s+(Consumes|Produces):\s*(.+?)\s*$/i.exec(line);
    if (contract !== null) {
      const direction = (contract[1] ?? "").toLowerCase();
      if (direction === "consumes" || direction === "produces") {
        interfaces.push({ direction, value: (contract[2] ?? "").trim() });
      }
      continue;
    }
    const runLine = /^\s*Run:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (runLine !== undefined) {
      run = runLine.trim();
      continue;
    }
    const expected = /^\s*Expected:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (expected !== undefined && run !== undefined) {
      verifications.push({ run, expected: expected.trim() });
      run = undefined;
    }
  }

  return { files, interfaces, verifications };
}

function stepId(body: string, ordinal: number): string {
  return /^(?:\*\*)?Step\s+(\d+(?:\.\d+)*)\b/i.exec(body)?.[1] ?? String(ordinal);
}

/** The checklist steps (`- [ ] …`) in `[start, end)`, with their 1-based file lines. */
function parseSteps(
  lines: readonly string[],
  path: string,
  start: number,
  end: number,
): SuperpowersPlanStep[] {
  const steps: SuperpowersPlanStep[] = [];
  for (let index = start; index < end; index += 1) {
    const match = CHECKBOX.exec(lines[index] ?? "");
    if (match === null) continue;
    const body = (match[3] ?? "").trim();
    steps.push({
      id: stepId(body, steps.length + 1),
      text: body,
      done: (match[2] ?? "").toLowerCase() === "x",
      source: sourceAt("plan", path, index + 1),
    });
  }
  return steps;
}

function taskGroupState(steps: readonly SuperpowersPlanStep[]): SuperpowersTaskGroup["state"] {
  if (steps.length === 0) return "static";
  return steps.every((step) => step.done) ? "complete" : "incomplete";
}

/** The plan header ends at the first Global Constraints heading or first Task heading. */
function planHeaderEnd(lines: readonly string[], headings: readonly Heading[]): number {
  const constraints = headings.find(
    (heading) => heading.level === 2 && /^Global Constraints$/i.test(heading.text),
  );
  const firstTask = headings.find(
    (heading) => heading.level === 3 && TASK_HEADING.test(heading.text),
  );
  return Math.min(constraints?.index ?? lines.length, firstTask?.index ?? lines.length);
}

function parsePlanDecisions(
  lines: readonly string[],
  path: string,
  headerEnd: number,
): SuperpowersPlanDecision[] {
  const decisions: SuperpowersPlanDecision[] = [];
  for (let index = 0; index < headerEnd; index += 1) {
    const match = /^\s*\*\*(Architecture|Tech Stack):\*\*\s*(\S(?:.*\S)?)\s*$/.exec(
      lines[index] ?? "",
    );
    if (match === null) continue;
    const label = match[1] as SuperpowersPlanDecision["label"];
    decisions.push({
      label,
      value: (match[2] ?? "").trim(),
      source: sourceAt("plan", path, index + 1),
    });
  }
  return decisions;
}

/** A `**Label:** value` header field's value, searched only within the plan header. */
function headerField(
  lines: readonly string[],
  headerEnd: number,
  label: string,
): string | undefined {
  const re = new RegExp(`^\\s*\\*\\*${label}:\\*\\*\\s*(\\S(?:.*\\S)?)\\s*$`);
  for (let index = 0; index < headerEnd; index += 1) {
    const value = re.exec(lines[index] ?? "")?.[1];
    if (value !== undefined) return value.trim();
  }
  return undefined;
}

function parseGlobalConstraints(lines: readonly string[], headings: readonly Heading[]): string[] {
  const heading = headings.find(
    (candidate) => candidate.level === 2 && /^Global Constraints$/i.test(candidate.text),
  );
  if (heading === undefined) return [];
  // End at the NEXT heading of any level: the `### Task N` groups sit below this `##`
  // but are peers of it, not children — `sectionEnd` (level ≤ own) would swallow them.
  const end = headings.find((candidate) => candidate.index > heading.index)?.index ?? lines.length;
  const constraints: string[] = [];
  for (let index = heading.index + 1; index < end; index += 1) {
    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (bullet !== null) constraints.push((bullet[1] ?? "").trim());
  }
  return constraints;
}

function parsePlan(artifact: SuperpowersArtifactText): SuperpowersPlan {
  const lines = toLines(artifact.md);
  const headings = findHeadings(lines);
  const headerEnd = planHeaderEnd(lines, headings);

  const taskGroups: SuperpowersTaskGroup[] = [];
  for (const heading of headings) {
    if (heading.level !== 3) continue;
    const id = TASK_HEADING.exec(heading.text)?.[1];
    if (id === undefined) continue;
    const end = sectionEnd(lines, headings, heading);
    const manifest = parseTaskManifest(lines, heading.index + 1, end);
    const hasManifest =
      manifest.files.length > 0 ||
      manifest.interfaces.length > 0 ||
      manifest.verifications.length > 0;
    const steps = parseSteps(lines, artifact.path, heading.index + 1, end);
    taskGroups.push({
      id,
      title: heading.text,
      ...(hasManifest ? { manifest } : {}),
      steps,
      state: taskGroupState(steps),
      total: steps.length,
      done: steps.filter((step) => step.done).length,
      source: sourceAt("plan", artifact.path, heading.index + 1),
    });
  }

  const goal = headerField(lines, headerEnd, "Goal");
  const specPath = headerField(lines, headerEnd, "Spec");
  return {
    path: artifact.path,
    ...(goal === undefined ? {} : { goal }),
    ...(specPath === undefined ? {} : { specPath }),
    decisions: parsePlanDecisions(lines, artifact.path, headerEnd),
    globalConstraints: parseGlobalConstraints(lines, headings),
    taskGroups,
    total: taskGroups.length,
    // ponytail: this rollup counts a group "done" only from its own step checkboxes. It can
    // disagree with design-obligations' deriveDesignTaskProgress, which also folds the
    // progress ledger's task-complete markers. Reconcile the two when the board assembler
    // consumes both this model and the ledger — not here (this parser stays ledger-agnostic).
    done: taskGroups.filter((group) => group.state === "complete").length,
  };
}

// ── progress ledger (.superpowers/sdd/**/progress.md) ────────────────────────

/** Classify one ledger line. Mirrors `superpowersProgressMarker` in design-obligations.ts. */
function progressMarker(line: string): SuperpowersProgressMarker {
  const binding = /^# SDD ledger — plan: (\S(?:.*\S)?)$/.exec(line)?.[1];
  if (binding !== undefined) return { kind: "plan-binding", planPath: binding };
  const complete = /^Task (\d+(?:\.\d+)*): complete \(.+\)$/.exec(line)?.[1];
  if (complete !== undefined) return { kind: "task-complete", taskId: complete };
  const fixRound = /^Task (\d+(?:\.\d+)*): fix round \d+\/5 \(.+\)$/.exec(line)?.[1];
  if (fixRound !== undefined) return { kind: "task-fix-round", taskId: fixRound };
  const minor = /^Task (\d+(?:\.\d+)*): minor \(deferred\): .+$/.exec(line)?.[1];
  if (minor !== undefined) return { kind: "task-minor", taskId: minor };
  if (/^Ruling: .+$/.test(line)) return { kind: "ruling" };
  return { kind: "other" };
}

/**
 * Parse a progress ledger. Returns `undefined` when the artifact's first non-empty
 * line is not a `# SDD ledger — plan: <path>` binding — an unbound file is not a
 * ledger, exactly as `parseSuperpowersProgressLedger` requires.
 */
function parseProgressLedger(
  artifact: SuperpowersArtifactText,
): SuperpowersProgressLedger | undefined {
  const lines = toLines(artifact.md);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return undefined;
  const binding = progressMarker(lines[firstIndex] ?? "");
  if (binding.kind !== "plan-binding") return undefined;

  const entries: SuperpowersProgressEntry[] = [];
  for (let index = firstIndex + 1; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (text.trim().length === 0) continue;
    entries.push({
      ...progressMarker(text),
      line: index + 1,
      text: text.trim(),
      source: sourceAt("progress", artifact.path, index + 1),
    });
  }
  return { path: artifact.path, planPath: binding.planPath, entries };
}

/**
 * Parse a whole Superpowers feature's artifact text into the structured model the
 * Design angle renders. Absent artifact kinds are empty arrays (never absent). A
 * progress artifact that is not a bound ledger is silently dropped from
 * `progressLedgers` (it is not a ledger), never thrown on.
 */
export function parseSuperpowersSpec(source: SuperpowersSpecSource): SuperpowersSpec {
  const specs = (source.specs ?? []).map(parseDesignSpec);
  const plans = (source.plans ?? []).map(parsePlan);
  const progressLedgers = (source.progress ?? [])
    .map(parseProgressLedger)
    .filter((ledger): ledger is SuperpowersProgressLedger => ledger !== undefined);

  return {
    name: source.name,
    specs,
    plans,
    progressLedgers,
    // Carry the raw artifact text verbatim alongside the parsed model: the Spec
    // viewer flips to it one keystroke away, never a re-serialization.
    raw: {
      specs: (source.specs ?? []).map((artifact) => ({ path: artifact.path, md: artifact.md })),
      plans: (source.plans ?? []).map((artifact) => ({ path: artifact.path, md: artifact.md })),
      progress: (source.progress ?? []).map((artifact) => ({
        path: artifact.path,
        md: artifact.md,
      })),
    },
  };
}
