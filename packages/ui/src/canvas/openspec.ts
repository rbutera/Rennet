import type {
  DispositionType,
  OpenSpecCapabilityNote,
  OpenSpecChange,
  OpenSpecDesignSection,
  OpenSpecProposal,
  OpenSpecRequirement,
  OpenSpecSpecDelta,
  OpenSpecTaskGroup,
} from "@rennet/types";
import type { AuthoringTrace } from "./authoring";
import type { DispositionWrite } from "./logic";

/**
 * The OpenSpec Spec-angle reading model (the "Spec" lens), pure derivation.
 *
 * The parser (`@rennet/core parseOpenSpecChange`) turns the change's markdown into
 * a structured `OpenSpecChange`; this module folds that into a render-ready view
 * model. Its one load-bearing job beyond shaping is REVIEW ANCHORING: every
 * addressable element (the whole change, the proposal, each capability, each design
 * section, each task group, each spec delta, each requirement, each scenario) gets
 * a STABLE anchor key. Those keys are the `path` a disposition is written against,
 * so comment / request-change / question on the Spec view flow through the SAME
 * `DispositionWrite` seam the diff lenses use — one disposition vocabulary, a wider
 * reach (the same "verbs × anchors" the disposition cluster is built for).
 *
 * Host-free by construction (`@rennet/ui` imports only types), so every keying and
 * counting rule here is unit-testable without Electron.
 */

/** The species of thing a Spec-view disposition is anchored to. */
export type OpenSpecAnchorKind =
  | "change"
  | "proposal"
  | "capability"
  | "design-section"
  | "task-group"
  | "spec-delta"
  | "requirement"
  | "scenario";

/** A stable review anchor: its kind, the disposition `path`, and a human label. */
export interface OpenSpecReviewAnchor {
  readonly kind: OpenSpecAnchorKind;
  /** The stable key a disposition writes against (the `DispositionWrite.path`). */
  readonly key: string;
  /** The accessible label the disposition cluster announces. */
  readonly label: string;
}

/** A slug for a key segment (lowercase, non-alphanumerics collapsed to `-`). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The anchor-key prefix for a change (`openspec:<name>`). */
function changeKey(name: string): string {
  return `openspec:${slug(name)}`;
}

// ── anchor builders (pure, the single source of every Spec-view key) ──────────

export function changeAnchor(change: OpenSpecChange): OpenSpecReviewAnchor {
  return { kind: "change", key: changeKey(change.name), label: change.name };
}

export function proposalAnchor(change: OpenSpecChange): OpenSpecReviewAnchor {
  return { kind: "proposal", key: `${changeKey(change.name)}/proposal`, label: "proposal" };
}

export function capabilityAnchor(
  change: OpenSpecChange,
  note: OpenSpecCapabilityNote,
): OpenSpecReviewAnchor {
  return {
    kind: "capability",
    key: `${changeKey(change.name)}/capability/${slug(note.name)}`,
    label: note.name,
  };
}

export function designSectionAnchor(
  change: OpenSpecChange,
  section: OpenSpecDesignSection,
): OpenSpecReviewAnchor {
  return {
    kind: "design-section",
    key: `${changeKey(change.name)}/design/${section.id}`,
    label: section.heading,
  };
}

export function taskGroupAnchor(
  change: OpenSpecChange,
  group: OpenSpecTaskGroup,
): OpenSpecReviewAnchor {
  return {
    kind: "task-group",
    key: `${changeKey(change.name)}/tasks/${group.id}`,
    label: group.title,
  };
}

export function specDeltaAnchor(
  change: OpenSpecChange,
  delta: OpenSpecSpecDelta,
): OpenSpecReviewAnchor {
  return {
    kind: "spec-delta",
    key: `${changeKey(change.name)}/spec/${slug(delta.capability)}`,
    label: delta.capability,
  };
}

export function requirementAnchor(
  change: OpenSpecChange,
  delta: OpenSpecSpecDelta,
  requirement: OpenSpecRequirement,
): OpenSpecReviewAnchor {
  return {
    kind: "requirement",
    key: `${changeKey(change.name)}/spec/${slug(delta.capability)}/${slug(requirement.name)}`,
    label: requirement.name,
  };
}

export function scenarioAnchor(
  change: OpenSpecChange,
  delta: OpenSpecSpecDelta,
  requirement: OpenSpecRequirement,
  scenarioName: string,
): OpenSpecReviewAnchor {
  return {
    kind: "scenario",
    key: `${changeKey(change.name)}/spec/${slug(delta.capability)}/${slug(requirement.name)}/${slug(scenarioName)}`,
    label: scenarioName,
  };
}

// ── the render-ready view model ───────────────────────────────────────────────

/** One capability note plus whether it is new or modified, plus its anchor. */
export interface OpenSpecCapabilityView {
  readonly note: OpenSpecCapabilityNote;
  readonly nature: "new" | "modified";
  readonly anchor: OpenSpecReviewAnchor;
}

export interface OpenSpecRequirementView {
  readonly requirement: OpenSpecRequirement;
  readonly anchor: OpenSpecReviewAnchor;
  /** Anchors for each scenario, index-aligned with `requirement.scenarios`. */
  readonly scenarioAnchors: readonly OpenSpecReviewAnchor[];
}

export interface OpenSpecDeltaView {
  readonly delta: OpenSpecSpecDelta;
  readonly anchor: OpenSpecReviewAnchor;
  readonly requirements: readonly OpenSpecRequirementView[];
}

export interface OpenSpecDesignSectionView {
  readonly section: OpenSpecDesignSection;
  readonly anchor: OpenSpecReviewAnchor;
}

export interface OpenSpecTaskGroupView {
  readonly group: OpenSpecTaskGroup;
  readonly anchor: OpenSpecReviewAnchor;
}

export interface OpenSpecProposalView {
  readonly proposal: OpenSpecProposal;
  readonly anchor: OpenSpecReviewAnchor;
  readonly capabilities: readonly OpenSpecCapabilityView[];
}

/** Whole-change counts for the view header (an honest, at-a-glance roll-up). */
export interface OpenSpecSummary {
  readonly requirements: number;
  readonly scenarios: number;
  readonly specCapabilities: number;
  readonly capabilities: number;
  readonly tasksTotal: number;
  readonly tasksDone: number;
  readonly designSections: number;
}

export interface OpenSpecViewModel {
  readonly name: string;
  readonly changeAnchor: OpenSpecReviewAnchor;
  readonly proposal?: OpenSpecProposalView;
  readonly designSections: readonly OpenSpecDesignSectionView[];
  readonly taskGroups: readonly OpenSpecTaskGroupView[];
  readonly specDeltas: readonly OpenSpecDeltaView[];
  readonly summary: OpenSpecSummary;
}

/**
 * Fold a parsed change into the render-ready Spec view model: the structured
 * artifacts, each addressable element carrying a stable review anchor, and a
 * whole-change summary. A pure function of its input — no host, no order-dependence.
 */
export function buildOpenSpecView(change: OpenSpecChange): OpenSpecViewModel {
  const proposal: OpenSpecProposalView | undefined = change.proposal
    ? {
        proposal: change.proposal,
        anchor: proposalAnchor(change),
        capabilities: [
          ...change.proposal.newCapabilities.map(
            (note): OpenSpecCapabilityView => ({
              note,
              nature: "new",
              anchor: capabilityAnchor(change, note),
            }),
          ),
          ...change.proposal.modifiedCapabilities.map(
            (note): OpenSpecCapabilityView => ({
              note,
              nature: "modified",
              anchor: capabilityAnchor(change, note),
            }),
          ),
        ],
      }
    : undefined;

  const designSections: OpenSpecDesignSectionView[] = (change.design?.sections ?? []).map(
    (section) => ({ section, anchor: designSectionAnchor(change, section) }),
  );

  const taskGroups: OpenSpecTaskGroupView[] = (change.tasks?.groups ?? []).map((group) => ({
    group,
    anchor: taskGroupAnchor(change, group),
  }));

  const specDeltas: OpenSpecDeltaView[] = change.specDeltas.map((delta) => ({
    delta,
    anchor: specDeltaAnchor(change, delta),
    requirements: delta.groups.flatMap((group) =>
      group.requirements.map(
        (requirement): OpenSpecRequirementView => ({
          requirement,
          anchor: requirementAnchor(change, delta, requirement),
          scenarioAnchors: requirement.scenarios.map((scenario) =>
            scenarioAnchor(change, delta, requirement, scenario.name),
          ),
        }),
      ),
    ),
  }));

  let requirements = 0;
  let scenarios = 0;
  for (const delta of change.specDeltas) {
    for (const group of delta.groups) {
      requirements += group.requirements.length;
      for (const requirement of group.requirements) scenarios += requirement.scenarios.length;
    }
  }

  const summary: OpenSpecSummary = {
    requirements,
    scenarios,
    specCapabilities: change.specDeltas.length,
    capabilities: proposal ? proposal.capabilities.length : 0,
    tasksTotal: change.tasks?.total ?? 0,
    tasksDone: change.tasks?.done ?? 0,
    designSections: designSections.length,
  };

  return {
    name: change.name,
    changeAnchor: changeAnchor(change),
    proposal,
    designSections,
    taskGroups,
    specDeltas,
    summary,
  };
}

/**
 * Author a disposition against a Spec-view anchor. A Spec anchor resolves to
 * exactly ONE `DispositionWrite` (its `key` is the path), so unlike the diff
 * lenses' cohort/roll-up fan-out this is a single write — but it produces the
 * IDENTICAL `DispositionWrite` shape and an `AuthoringTrace`, so a Spec disposition
 * rides the same staging/publish batch as any other. `body` is the reviewer's
 * sovereign text, carried verbatim (empty for a bare verb press).
 */
export function authorOpenSpecDisposition(
  anchor: OpenSpecReviewAnchor,
  type: DispositionType,
  body = "",
): { writes: DispositionWrite[]; trace: AuthoringTrace } {
  const writes: DispositionWrite[] = [{ path: anchor.key, type, body }];
  return { writes, trace: { granularity: "element", source: anchor.key, writes } };
}
