/**
 * The deterministic Design board assembler (phase 1: OpenSpec format).
 *
 * The Design lens is a model-free transform: it renders the change's OWN artifacts and
 * forbids inference. So when a branch carries an OpenSpec change, the board it would
 * produce is fully decided by the artifact text — there is nothing for a model turn to
 * decide. This builds that board on the host, driving the same {@link BoardWriter} a
 * seat would, so every element passes the same boundary + finish lint. No model, no
 * spend, and it is the fastest lens.
 *
 * A PURE ADDITIVE fast path: the caller runs the existing Design seat whenever this
 * returns `undefined` (no sources, or a change with no renderable obligations). The seat
 * is never removed.
 *
 * A refusal is never swallowed. The mapping from a valid OpenSpec change to board calls
 * is deterministic, so a refusal or an unsettled `finish` is a defect — this throws with
 * the pointer text rather than shipping a board the lint would reject.
 */

import type { Author, DraftBoard } from "@rennet/protocol";
import { type BoardToolOutcome, type BoardToolResult, BoardWriter } from "./board-writer";
import {
  type CandidateDesignSource,
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

/** The prose under a proposal's `## Why` heading, or `undefined` when there is none. */
function proposalWhy(proposal: CandidateDesignSource | undefined): string | undefined {
  if (proposal === undefined) return undefined;
  const lines = proposal.text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+Why\b/i.test(line));
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

/**
 * Build the Design board for one OpenSpec change deterministically, or `undefined` when
 * there is nothing to render (empty sources, or a change whose artifacts yield no
 * obligations — a bare proposal with no spec-delta, tasks, or stated decision).
 */
export function assembleDesignBoard(
  sources: readonly CandidateDesignSource[],
  lint: Omit<LintContext, "lens">,
  author: Author,
): DraftBoard | undefined {
  const first = sources[0];
  if (first === undefined) return undefined;

  const obligationsBySource = new Map<CandidateDesignSource, readonly DesignSourceObligation[]>();
  for (const source of sources) {
    obligationsBySource.set(source, parseDesignSourceObligations(source));
  }
  const allObligations = [...obligationsBySource.values()].flat();
  if (allObligations.length === 0) return undefined;

  const byRole = (role: string): CandidateDesignSource | undefined =>
    sources.find((source) => source.role === role);
  const proposal = byRole("proposal");
  const design = byRole("design");
  const tasks = byRole("tasks");
  const specDeltas = sources.filter((source) => source.role === "spec-delta");
  // OpenSpec RENAMED sections are `FROM:`/`TO:` list pairs, not `### Requirement:` headings,
  // so the parser yields no obligation for them: rendering here would drop the rename AND
  // undercount the Requirements stat. Route the whole change to the seat instead, which
  // reads the rename pair directly. (Renames are rare; correctness beats the fast path.)
  if (specDeltas.some((source) => /^##\s+RENAMED\s+Requirements\b/im.test(source.text))) {
    return undefined;
  }
  const readingOrder = [proposal, design, tasks, ...specDeltas].filter(
    (source): source is CandidateDesignSource => source !== undefined,
  );

  const progress = deriveDesignTaskProgress(sources);
  const requirementCount = allObligations.filter(
    (obligation) => obligation.kind === "requirement",
  ).length;
  const candidate = first.candidate;

  const writer = new BoardWriter({ target: "design", lint, author });
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

  must(
    writer.call("set_document", {
      title: candidate,
      // ponytail: the `## Why` prose ships verbatim; a Why that trips a prose rule (a code
      // fence, a machinery word) throws rather than being sanitized. Ceiling: OpenSpec
      // Why sections are plain English. Upgrade path: strip offending spans if it bites.
      intro_markdown: proposalWhy(proposal) ?? `OpenSpec change ${candidate}.`,
      source_paths: readingOrder.map((source) => source.path),
      stat_labels: ["Format", "Capabilities", "Requirements", "Tasks"],
      stat_values: [
        "OpenSpec",
        String(specDeltas.length),
        String(requirementCount),
        `${progress.done}/${progress.total}`,
      ],
    }),
    "set_document",
  );

  if (proposal !== undefined) {
    addElement("add_section", { title: "Proposal", source_paths: [proposal.path] });
  }

  if (design !== undefined) {
    const sectionId = addElement("add_section", { title: "Design", source_paths: [design.path] });
    for (const obligation of obligationsBySource.get(design) ?? []) {
      if (obligation.kind !== "decision") continue;
      // ponytail: skip a decision with no stated rationale — `why` is required and the
      // Design lens forbids inventing one.
      if (obligation.rationale === undefined) continue;
      addElement("add_decision", {
        statement: obligation.text,
        why: obligation.rationale,
        evidence_ref_ids: [],
        alternative_ids: [],
        inferred: false,
        source_path: design.path,
        source_line: obligation.line,
        parent_id: sectionId,
      });
    }
  }

  if (tasks !== undefined) {
    const sectionId = addElement("add_section", { title: "Tasks", source_paths: [tasks.path] });
    const progressSource = progress.sources.find((source) => source.source === tasks);
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

  for (const delta of specDeltas) {
    const obligations = obligationsBySource.get(delta) ?? [];
    const capability = /specs\/([^/]+)\/spec\.md$/.exec(delta.path)?.[1] ?? delta.candidate;
    const sectionId = addElement("add_section", { title: capability, source_paths: [delta.path] });

    const scenariosByParent = new Map<string, DesignSourceObligation[]>();
    for (const obligation of obligations) {
      if (obligation.kind !== "scenario") continue;
      scenariosByParent.set(obligation.parentKey, [
        ...(scenariosByParent.get(obligation.parentKey) ?? []),
        obligation,
      ]);
    }

    for (const requirement of obligations) {
      if (requirement.kind !== "requirement") continue;
      // Scenario prose sits TOP-LEVEL (no parent_id) and is nested under the requirement
      // only through `scenario_ids`: `requirement-scenario-parenting` refuses a scenario
      // that is both a section child and a requirement reference.
      const scenarioIds = (scenariosByParent.get(requirement.key) ?? []).map((scenario) =>
        addElement("add_prose", { markdown: scenario.text }),
      );
      const operation = /requirements:(\w+)$/.exec(requirement.parentKey)?.[1];
      addElement("add_requirement", {
        shall: requirement.text,
        ...(requirement.label === undefined ? {} : { name: requirement.label }),
        ...(requirement.capability === undefined ? {} : { capability: requirement.capability }),
        ...(scenarioIds.length === 0 ? {} : { scenario_ids: scenarioIds }),
        ...(operation !== undefined && SPEC_DELTA_OPERATIONS.has(operation)
          ? { spec_delta: operation }
          : {}),
        source_path: delta.path,
        source_line: requirement.line,
        parent_id: sectionId,
      });
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
