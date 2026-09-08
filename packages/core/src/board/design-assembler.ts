/**
 * The deterministic Design board assembler.
 *
 * The Design lens is a model-free transform: it renders the change's OWN artifacts and
 * forbids inference. So when a branch carries a specification in a format the obligation
 * parser reads — OpenSpec, Kiro, BMAD, Superpowers, grill-with-docs — the board it would
 * produce is fully decided by the artifact text — there is nothing for a model turn to
 * decide. This builds that board on the host, driving the same {@link BoardWriter} a
 * seat would, so every element passes the same boundary + finish lint. No model, no
 * spend, and it is the fastest lens.
 *
 * It renders by OBLIGATION KIND, not by format: `parseDesignSourceObligations` already
 * turns every format's files into requirements, scenarios, decisions, tasks, bug-fix
 * sections, glossary terms and progress entries, and this file only knows how each kind
 * lands on a board. The format decides a source's section title and the document's intro,
 * and nothing else.
 *
 * It writes in the `transcribed` register (#877): every string it emits is the change's
 * own text shipped verbatim, or a fixed label. The `BoardRegister` doc in `lint.ts` is
 * the whole argument, and the short of it is that a rule telling a WRITER to choose
 * different words has no subject here, while every rule protecting a READER from a
 * broken board still runs and still refuses.
 *
 * A PURE ADDITIVE fast path: the caller runs the existing Design seat whenever this
 * returns `undefined` (no sources, or a change with no renderable obligations). The seat
 * is never removed.
 *
 * A refusal is never swallowed. The mapping from a valid specification to board calls is
 * deterministic, so a refusal or an unsettled `finish` is a defect — this throws with
 * the pointer text rather than shipping a board the lint would reject. The caller logs
 * that throw before falling back, because an avoidable model seat nobody can see is the
 * defect #877 was filed for.
 */

import type { Author, DraftBoard } from "@rennet/protocol";
import { type BoardToolOutcome, type BoardToolResult, BoardWriter } from "./board-writer";
import {
  type CandidateDesignSource,
  type DesignSourceFormat,
  type DesignSourceObligation,
  type DesignTaskProgressGroup,
  deriveDesignTaskProgress,
  parseDesignSourceObligations,
} from "./design-obligations";
import type { LintContext } from "./lint";

const SPEC_DELTA_OPERATIONS: ReadonlySet<string> = new Set([
  "added",
  "modified",
  "removed",
  "renamed",
]);

/** The format label shown as the first stat, and used in the fallback intro. */
const FORMAT_LABEL: Readonly<Record<DesignSourceFormat, string>> = {
  openspec: "OpenSpec",
  kiro: "Kiro",
  bmad: "BMAD",
  superpowers: "Superpowers",
  "grill-with-docs": "grill-with-docs",
};

/** What the document is called when its own files state no intro. */
const FORMAT_NOUN: Readonly<Record<DesignSourceFormat, string>> = {
  openspec: "change",
  kiro: "feature",
  bmad: "specification",
  superpowers: "feature",
  "grill-with-docs": "specification",
};

/**
 * The section title for a source's role, per format. A role absent here titles its
 * section by file stem, which is what an epic, a story, an ADR or an architecture shard
 * is called in its own repository.
 */
const ROLE_TITLE: Readonly<Record<DesignSourceFormat, Readonly<Record<string, string>>>> = {
  openspec: { proposal: "Proposal", design: "Design", tasks: "Tasks" },
  kiro: { requirements: "Requirements", design: "Design", tasks: "Tasks", bugfix: "Bug Fix" },
  bmad: { prd: "PRD" },
  superpowers: { design: "Spec", plan: "Plan", progress: "Progress" },
  "grill-with-docs": { context: "Context", "context-map": "Context Map" },
};

/**
 * The heading whose prose opens the document, per format: the one place a specification
 * states why it exists in its own words. Formats without such a heading fall back to a
 * fixed label; the assembler never writes a rationale of its own.
 */
const INTRO_HEADING: Readonly<
  Partial<Record<DesignSourceFormat, { role: string; heading: RegExp }>>
> = {
  openspec: { role: "proposal", heading: /^##\s+Why\b/i },
  kiro: { role: "requirements", heading: /^##\s+Introduction\b/i },
};

/** The file stem of a repo-relative path (`docs/adr/0003-foo.md` → `0003-foo`). */
function pathStem(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

/** The prose under the first heading matching `heading`, or `undefined` when none. */
function headingProse(source: CandidateDesignSource, heading: RegExp): string | undefined {
  const lines = source.text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length === 0 ? undefined : text;
}

/** One heading-bounded slice of a markdown file: the heading's own title, its level, and
 *  the lines beneath it up to the next heading of the same or a higher level. */
interface MarkdownSlice {
  readonly level: number;
  readonly title: string;
  readonly lines: readonly string[];
}

/** Split `lines` into the slices headed at `level`, dropping anything before the first
 *  such heading. A slice keeps its deeper headings inside its own lines, so a caller can
 *  slice again one level down. */
function markdownSlices(lines: readonly string[], level: number): MarkdownSlice[] {
  const opens = new RegExp(`^#{${level}}\\s+(.+?)\\s*$`);
  const closes = new RegExp(`^#{1,${level}}\\s+`);
  const slices: MarkdownSlice[] = [];
  let current: { title: string; lines: string[] } | undefined;
  for (const line of lines) {
    const heading = opens.exec(line)?.[1];
    if (heading !== undefined) {
      if (current !== undefined) slices.push({ level, ...current });
      current = { title: heading, lines: [] };
      continue;
    }
    if (current === undefined) continue;
    if (closes.test(line)) {
      slices.push({ level, ...current });
      current = undefined;
      continue;
    }
    current.lines.push(line);
  }
  if (current !== undefined) slices.push({ level, ...current });
  return slices;
}

/** The lines of `slice` before its first deeper heading. */
function leadingLines(slice: MarkdownSlice): string[] {
  const end = slice.lines.findIndex((line) => /^#{1,6}\s+/.test(line));
  return [...(end === -1 ? slice.lines : slice.lines.slice(0, end))];
}

/** The top-level list items of a markdown body, each with its continuation lines joined
 *  and its marker removed. The same reading `design-artifact-anatomy` applies to the
 *  proposal's What Changes rows, so the rows this ships are the rows that lint expects. */
function topLevelListItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    const item = /^[-*]\s+(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) {
      if (current !== undefined) items.push(current.join(" "));
      current = [item];
      continue;
    }
    if (current !== undefined && line.trim().length > 0 && !/^#{1,6}\s+/.test(line)) {
      current.push(line.trim());
    }
  }
  if (current !== undefined) items.push(current.join(" "));
  return items.map((item) => item.replace(/\s+/g, " ").trim());
}

/** A proposal heading whose prose is a list of rows, one per top-level item: the reader
 *  sees each change as its own line, the way the proposal states it, and the client's
 *  What Changes spine renders each row on its own. Every other heading ships its prose
 *  verbatim in one block. */
const PROPOSAL_ROW_HEADINGS: ReadonlySet<string> = new Set(["what changes"]);

/** The fixed label that stands where a proposal's fenced code block was. Code on a board
 *  is a `code_ref`, never bytes in prose (`no-code-bytes`), and a proposal's fence is
 *  illustration rather than a patchset region to cite, so the block is left out and its
 *  absence is stated, rather than the whole change losing its free board over it. */
const OMITTED_CODE_BLOCK = "*(A code block here is not shown; read it in the file.)*";

/** Proposal prose as the board carries it: fenced blocks replaced by the label above, and
 *  a nested list's four-space indent halved so a two-line nested item does not read as an
 *  indented code block. Whitespace is the only thing that changes. */
function proposalProse(lines: readonly string[]): string {
  const kept: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (!fenced) kept.push(OMITTED_CODE_BLOCK);
      continue;
    }
    if (fenced) continue;
    kept.push(
      line.replace(/^(?: {4}|\t)+/, (indent) =>
        "  ".repeat(indent.replace(/\t/g, "    ").length / 4),
      ),
    );
  }
  if (fenced) kept.push(OMITTED_CODE_BLOCK);
  return kept.join("\n").trim();
}

/** The format every source shares; a mixed set has no single format and is not ours. */
function formatOfSources(
  sources: readonly CandidateDesignSource[],
): DesignSourceFormat | undefined {
  const formats = new Set(sources.map((source) => source.format));
  if (formats.size !== 1) return undefined;
  return sources[0]?.format;
}

/**
 * A source's section title. An OpenSpec spec-delta is titled by its capability, a role
 * the table names by that name, and everything else by its file stem. When two sources
 * share a role AND a title (two plans, two shards), the stem is appended so the reader
 * can tell the sections apart.
 */
function sectionTitle(
  source: CandidateDesignSource,
  format: DesignSourceFormat,
  sources: readonly CandidateDesignSource[],
): string {
  if (format === "openspec" && source.role === "spec-delta") {
    return /specs\/([^/]+)\/spec\.md$/.exec(source.path)?.[1] ?? source.candidate;
  }
  const named = ROLE_TITLE[format][source.role];
  if (named === undefined) return pathStem(source.path);
  const siblings = sources.filter((other) => other.role === source.role);
  return siblings.length > 1 ? `${named}: ${pathStem(source.path)}` : named;
}

/**
 * Build the Design board for one specification deterministically, or `undefined` when
 * there is nothing to render (empty sources, sources of more than one format, or a
 * specification whose artifacts yield no obligations — a bare proposal with no
 * spec-delta, tasks, or stated decision).
 */
export function assembleDesignBoard(
  sources: readonly CandidateDesignSource[],
  lint: Omit<LintContext, "lens">,
  author: Author,
): DraftBoard | undefined {
  const first = sources[0];
  if (first === undefined) return undefined;
  const format = formatOfSources(sources);
  if (format === undefined) return undefined;

  const obligationsBySource = new Map<CandidateDesignSource, readonly DesignSourceObligation[]>();
  for (const source of sources) {
    obligationsBySource.set(source, parseDesignSourceObligations(source));
  }
  const allObligations = [...obligationsBySource.values()].flat();
  if (allObligations.length === 0) return undefined;

  // OpenSpec RENAMED sections are `FROM:`/`TO:` list pairs, not `### Requirement:` headings,
  // so the parser yields no obligation for them: rendering here would drop the rename AND
  // undercount the Requirements stat. Route the whole change to the seat instead, which
  // reads the rename pair directly. (Renames are rare; correctness beats the fast path.)
  if (
    format === "openspec" &&
    sources.some(
      (source) =>
        source.role === "spec-delta" && /^##\s+RENAMED\s+Requirements\b/im.test(source.text),
    )
  ) {
    return undefined;
  }

  const progress = deriveDesignTaskProgress(sources);
  const requirementCount = allObligations.filter(
    (obligation) => obligation.kind === "requirement",
  ).length;
  // OpenSpec counts capability files; every other format counts the files that state a
  // requirement, which is the nearest thing it has to a capability.
  const capabilityCount =
    format === "openspec"
      ? sources.filter((source) => source.role === "spec-delta").length
      : sources.filter((source) =>
          (obligationsBySource.get(source) ?? []).some(
            (obligation) => obligation.kind === "requirement",
          ),
        ).length;
  const candidate = first.candidate;

  // `transcribed`, because this function authors nothing (#877). Every string below is
  // either the change's own text shipped verbatim or a fixed label ("Proposal", "Design",
  // "Tasks", "OpenSpec"), so the voice screens have no writer to address and refusing on
  // one throws away a free board to buy a model seat that renders the same quoted text.
  // The integrity screens — explicit references, code bytes, the whole finish tier —
  // still run, and still throw. See `BoardRegister` in `lint.ts` for the whole reasoning.
  const writer = new BoardWriter({ target: "design", lint, author, register: "transcribed" });
  const must = (result: BoardToolResult, what: string): BoardToolOutcome => {
    if (!result.ok) throw new Error(`design-assembler: ${what} refused — ${result.refusal}`);
    return result.outcome;
  };
  const addElement = (name: string, input: Record<string, unknown>): string => {
    const outcome = must(writer.call(name, input), name);
    if (outcome.kind !== "element") {
      throw new Error(`design-assembler: ${name} returned \`${outcome.kind}\`, not an element.`);
    }
    return outcome.id;
  };
  // Host-derived projections (#898): the structured halves the parser split off a line —
  // a glossary term, a task's requirement refs and acceptance criteria, a group's
  // manifest, a decision's table cells, a story's status, task progress. The renderer has
  // read these off element data all along and persistence keeps them (`withAuthor` is a
  // loose object), but no verb carries them: they are not authored fields, and #889 is
  // the reason they will not become seven more tool inputs. The host is the one writer
  // holding the parsed structure, so it stamps them onto the elements it built, after
  // the board settles — a transcription of the same source text the element already
  // quotes, keyed by element id.
  const stamps = new Map<string, Record<string, unknown>>();
  const stamp = (id: string, fields: Record<string, unknown>): void => {
    stamps.set(id, { ...(stamps.get(id) ?? {}), ...fields });
  };

  // ponytail: fenced source code still falls back to the seat. Rendering quoted code
  // blocks belongs to a separate change; illustrative file references remain prose.
  const introSpec = INTRO_HEADING[format];
  const introSource =
    introSpec === undefined ? undefined : sources.find((source) => source.role === introSpec.role);
  const intro =
    introSpec !== undefined && introSource !== undefined
      ? headingProse(introSource, introSpec.heading)
      : undefined;

  must(
    writer.call("set_document", {
      title: candidate,
      intro_markdown: intro ?? `${FORMAT_LABEL[format]} ${FORMAT_NOUN[format]} ${candidate}.`,
      source_paths: sources.map((source) => source.path),
      stat_labels: ["Format", "Capabilities", "Requirements", "Tasks"],
      stat_values: [
        FORMAT_LABEL[format],
        String(capabilityCount),
        String(requirementCount),
        `${progress.done}/${progress.total}`,
      ],
    }),
    "set_document",
  );

  for (const source of sources) {
    const obligations = obligationsBySource.get(source) ?? [];
    const sectionId = addElement("add_section", {
      title: sectionTitle(source, format, sources),
      source_paths: [source.path],
    });

    // An OpenSpec proposal yields no obligation of its own — its `## Why` opens the
    // document and nothing else it says is a requirement, a decision or a task — so
    // without this the Proposal section shipped EMPTY (Rai, 2026-09-08: "proposal is
    // empty no matter if i collapse or expand"). Its remaining headings are the change's
    // own words about itself: What Changes as one row per listed change (the shape the
    // client's proposal spine and `design-artifact-anatomy` both read), Impact and the
    // rest verbatim, and a deeper heading as a nested section, since the prose renderer
    // has no heading of its own. The heading that became the intro is not repeated.
    if (format === "openspec" && source.role === "proposal") {
      const introHeading =
        introSpec !== undefined && intro !== undefined ? introSpec.heading : undefined;
      const lines = source.text.replace(/\r\n?/g, "\n").split("\n");
      const placeProse = (slice: MarkdownSlice, parentId: string): void => {
        const body = leadingLines(slice);
        const rows = PROPOSAL_ROW_HEADINGS.has(slice.title.trim().toLowerCase())
          ? topLevelListItems(proposalProse(body).split("\n"))
          : [proposalProse(body)].filter((text) => text.length > 0);
        for (const markdown of rows) addElement("add_prose", { markdown, parent_id: parentId });
        for (const nested of markdownSlices(slice.lines, slice.level + 1)) {
          if (nested.lines.every((line) => line.trim().length === 0)) continue;
          const nestedId = addElement("add_section", { title: nested.title, parent_id: parentId });
          placeProse(nested, nestedId);
        }
      };
      for (const slice of markdownSlices(lines, 2)) {
        if (introHeading?.test(`## ${slice.title}`) === true) continue;
        if (slice.lines.every((line) => line.trim().length === 0)) continue;
        const headingId = addElement("add_section", { title: slice.title, parent_id: sectionId });
        placeProse(slice, headingId);
      }
    }

    const scenariosByParent = new Map<string, DesignSourceObligation[]>();
    for (const obligation of obligations) {
      if (obligation.kind !== "scenario") continue;
      scenariosByParent.set(obligation.parentKey, [
        ...(scenariosByParent.get(obligation.parentKey) ?? []),
        obligation,
      ]);
    }

    // Everything but tasks, in source line order. Tasks follow as their own groups.
    for (const obligation of obligations) {
      switch (obligation.kind) {
        case "requirement": {
          // Scenario prose sits TOP-LEVEL (no parent_id) and is nested under the
          // requirement only through `scenario_ids`: `requirement-scenario-parenting`
          // refuses a scenario that is both a section child and a requirement reference.
          const scenarioIds = (scenariosByParent.get(obligation.key) ?? []).map((scenario) =>
            addElement("add_prose", {
              markdown: scenario.text,
              // #856: a WHEN/THEN scenario the parser split renders as a Trigger/Outcome
              // row. Both halves or neither — the writer refuses one without the other.
              ...(scenario.kind === "scenario" && scenario.clauses !== undefined
                ? {
                    scenario_condition: scenario.clauses.condition,
                    scenario_response: scenario.clauses.response,
                  }
                : {}),
            }),
          );
          const operation = /requirements:(\w+)$/.exec(obligation.parentKey)?.[1];
          const requirementId = addElement("add_requirement", {
            shall: obligation.text,
            ...(obligation.label === undefined ? {} : { name: obligation.label }),
            ...(obligation.capability === undefined ? {} : { capability: obligation.capability }),
            ...(scenarioIds.length === 0 ? {} : { scenario_ids: scenarioIds }),
            ...(operation !== undefined && SPEC_DELTA_OPERATIONS.has(operation)
              ? { spec_delta: operation }
              : {}),
            source_path: source.path,
            source_line: obligation.line,
            parent_id: sectionId,
          });
          if (obligation.status !== undefined) stamp(requirementId, { status: obligation.status });
          break;
        }
        case "decision": {
          // ponytail: skip a decision with no stated rationale — `why` is required and
          // the Design lens forbids inventing one.
          if (obligation.rationale === undefined) break;
          const decisionId = addElement("add_decision", {
            statement: obligation.text,
            why: obligation.rationale,
            evidence_ref_ids: [],
            // Plain text now, not element ids (#864 fold-in). The Design assembler states
            // no alternatives of its own — the artifact's are the seat's to read — so it
            // stays empty; the field's shape is what changed, not what this call says.
            alternatives: [],
            inferred: false,
            source_path: source.path,
            source_line: obligation.line,
            parent_id: sectionId,
          });
          if (obligation.sourceCells !== undefined) {
            stamp(decisionId, { source_cells: obligation.sourceCells });
          }
          break;
        }
        case "source-section": {
          // A Kiro bug fix's current / expected / unchanged behaviour, under its own
          // heading, with the prose beneath it verbatim.
          const headingId = addElement("add_section", {
            title: obligation.heading,
            parent_id: sectionId,
          });
          addElement("add_prose", { markdown: obligation.text, parent_id: headingId });
          break;
        }
        case "glossary-term": {
          // The entry's own lines, verbatim, and the term / definition / avoid triple the
          // parser split off them, which the renderer shows as a glossary card.
          const termId = addElement("add_prose", {
            markdown: obligation.text,
            parent_id: sectionId,
          });
          stamp(termId, {
            glossary_term: {
              term: obligation.term,
              definition: obligation.definition,
              avoid: obligation.avoid,
            },
          });
          break;
        }
        case "progress-entry":
          // A ledger row, verbatim.
          addElement("add_prose", { markdown: obligation.text, parent_id: sectionId });
          break;
        case "scenario":
        case "task":
          break;
        default: {
          const exhaustive: never = obligation;
          return exhaustive;
        }
      }
    }

    const progressSource = progress.sources.find((entry) => entry.source === source);
    if (progressSource !== undefined) {
      // One prose element per task, so each task is its own disposition anchor and
      // carries its own refs and criteria. `obligation.text` is the whole checklist line
      // already (`- [x] …`), so it ships verbatim — re-wrapping it in another `- [ ] `
      // doubled the marker on every task.
      const placeTasks = (group: DesignTaskProgressGroup, parentId: string): void => {
        for (const taskObligation of group.tasks) {
          const taskId = addElement("add_prose", {
            markdown: taskObligation.text,
            parent_id: parentId,
          });
          stamp(taskId, {
            ...(taskObligation.requirementRefs === undefined
              ? {}
              : { requirement_refs: taskObligation.requirementRefs }),
            ...(taskObligation.acceptanceCriteria === undefined
              ? {}
              : { acceptance_criteria: taskObligation.acceptanceCriteria }),
          });
        }
      };
      const [only] = progressSource.groups;
      if (progressSource.groups.length === 1 && only !== undefined && only.title === undefined) {
        // One flat list: the tasks sit directly under the source section, and the
        // section's progress is the count.
        placeTasks(only, sectionId);
        stamp(sectionId, {
          task_progress: {
            kind: "source",
            format: progressSource.format,
            role: source.role,
            layout: "ungrouped",
            done: progressSource.done,
            total: progressSource.total,
          },
        });
      } else {
        stamp(sectionId, {
          task_progress: {
            kind: "source",
            format: progressSource.format,
            role: source.role,
            layout: "grouped",
          },
        });
        for (const group of progressSource.groups) {
          const groupId = addElement("add_section", {
            title: group.title ?? "Tasks",
            parent_id: sectionId,
          });
          // The manifest rides on a group's first task (`parseSuperpowersTaskManifest`).
          const manifest = group.tasks[0]?.manifest;
          stamp(groupId, {
            task_progress: { kind: "group", state: group.complete ? "complete" : "incomplete" },
            ...(manifest === undefined ? {} : { task_manifest: manifest }),
          });
          placeTasks(group, groupId);
        }
      }
    }
  }

  const finished = must(writer.call("finish"), "finish");
  if (finished.kind !== "settled") {
    const detail =
      finished.kind === "pointers"
        ? finished.pointers
            .map((pointer) => `${pointer.ruleId} @ ${pointer.elementRef}: ${pointer.message}`)
            .join("; ")
        : `unexpected \`${finished.kind}\``;
    throw new Error(`design-assembler: board did not settle — ${detail}`);
  }
  const board = writer.board();
  return {
    ...board,
    ...(board.document === undefined
      ? {}
      : { document: { ...board.document, proseRegister: "transcribed" } }),
    elements: board.elements.map((element) => {
      const fields = stamps.get(element.id);
      if (fields === undefined) return element;
      // The spread widens the kind union; the element's own kind is what it stays.
      return { ...element, data: { ...element.data, ...fields } } as typeof element;
    }),
  };
}
