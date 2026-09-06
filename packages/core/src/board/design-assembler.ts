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
  // The integrity screens — citations, references, code bytes, the whole finish tier —
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

  // ponytail: the intro prose ships verbatim; an intro that trips an INTEGRITY rule (a
  // code fence, an unresolvable citation) throws rather than being sanitized. Machinery
  // words no longer bite — the register answers those. Ceiling: Why / Introduction
  // sections are plain English. Upgrade path: strip offending spans if it bites.
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
          addElement("add_requirement", {
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
          break;
        }
        case "decision": {
          // ponytail: skip a decision with no stated rationale — `why` is required and
          // the Design lens forbids inventing one.
          if (obligation.rationale === undefined) break;
          addElement("add_decision", {
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
        case "glossary-term":
        case "progress-entry":
          // The line itself, verbatim: a glossary entry or a ledger row. The structured
          // halves the parser split off are not authorable fields on the surface, so the
          // reader gets the source's own line.
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
    for (const group of progressSource?.groups ?? []) {
      const groupId = addElement("add_section", {
        title: group.title ?? "Tasks",
        parent_id: sectionId,
      });
      // `obligation.text` is the whole checklist line already (`- [x] …`), so it ships
      // verbatim — re-wrapping it in another `- [ ] ` doubled the marker on every task.
      const checklist = group.tasks.map((taskObligation) => taskObligation.text).join("\n");
      addElement("add_prose", { markdown: checklist, parent_id: groupId });
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
  return writer.board();
}
