import type {
  AnchorSide,
  AnchorSpan,
  DispositionType,
  OpenSpecArtifact,
  OpenSpecCapabilityNote,
  OpenSpecChange,
  OpenSpecChangeRaw,
  OpenSpecDeltaOperation,
  OpenSpecDesignSection,
  OpenSpecProposal,
  OpenSpecRequirement,
  OpenSpecRequirementCoverage,
  OpenSpecSource,
  OpenSpecSpecDelta,
  OpenSpecTaskGroup,
  OpenSpecTaskItem,
} from "@rennet/protocol";
import { openSpecRequirementCoverageKey } from "@rennet/protocol";
import type { AuthoringTrace } from "./authoring";
import { anchorPathKey, type DispositionWrite } from "./logic";

/**
 * The OpenSpec Spec-angle reading model (the "Spec" lens), pure derivation.
 *
 * The parser (`@rennet/core parseOpenSpecChange`) turns the change's markdown into
 * a structured `OpenSpecChange`; this module folds that into a render-ready view
 * model. Its load-bearing job beyond shaping is REVIEW ANCHORING: every addressable
 * element gets a stable anchor with TWO parts —
 *   • `key`: a structural id (React keys, jump targets, local identity), and
 *   • `target`: the DURABLE disposition address — the REAL artifact file path
 *     (`openspec/changes/<name>/<artifact>`) plus a single-line span at the node's
 *     source line.
 * The target is what makes a Spec review affordance persist: a disposition is
 * written against the real file (which is in the reviewed patchset when the PR
 * edits the change) at a per-node line span, so the engine accepts it and distinct
 * nodes on the same file (e.g. five requirements in one `spec.md`) get distinct
 * spans rather than colliding on one path. Diff-lens behaviour is unchanged (they
 * carry no span → path-grained, exactly as before).
 *
 * Host-free by construction (`@rennet/ui` imports only types + protocol), so every
 * keying and targeting rule here is unit-testable without Electron.
 */

/** The species of thing a Spec-view disposition is anchored to. */
export type OpenSpecAnchorKind =
  | "change"
  | "capability"
  | "why-block"
  | "design-section"
  | "task-group"
  | "task-item"
  | "spec-delta"
  | "requirement"
  | "scenario";

/**
 * The durable disposition address for an anchor: the real artifact file path and,
 * when the node has a known source line, a single-line span (with `side`) so
 * distinct nodes on one file don't collide. Absent only when the node carries no
 * source (a hand-built fixture) — then the affordance degrades to the structural
 * key, which is honest-but-non-durable.
 */
export interface OpenSpecAnchorTarget {
  readonly path: string;
  readonly span?: AnchorSpan;
  readonly side?: AnchorSide;
}

/** A stable review anchor: its kind, a structural `key`, a label, and a durable target. */
export interface OpenSpecReviewAnchor {
  readonly kind: OpenSpecAnchorKind;
  /** A structural id — React keys, jumps, local identity. NOT the disposition path. */
  readonly key: string;
  /** The accessible label the disposition cluster announces. */
  readonly label: string;
  /** The durable disposition address (real file path + line span). Absent ⇒ no source. */
  readonly target?: OpenSpecAnchorTarget;
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

/** The repo-relative artifact file path a node's source points at. */
function artifactPath(name: string, source: OpenSpecSource): string {
  const base = `openspec/changes/${name}`;
  const byArtifact: Record<OpenSpecArtifact, string> = {
    proposal: `${base}/proposal.md`,
    design: `${base}/design.md`,
    tasks: `${base}/tasks.md`,
    spec: `${base}/specs/${source.capability ?? ""}/spec.md`,
  };
  return byArtifact[source.artifact];
}

/**
 * The durable target for a node: its real file path + a single-line span at the
 * node's source line. `side` is `additions` — the node's line reads on the new-file
 * image, correct for an added/edited artifact (a review of a PR that ships the
 * change). Absent source ⇒ no durable target (honest degradation).
 */
function targetFrom(
  name: string,
  source: OpenSpecSource | undefined,
): OpenSpecAnchorTarget | undefined {
  if (!source) return undefined;
  return { path: artifactPath(name, source), span: { startLine: source.line }, side: "additions" };
}

/** A path-grained target on a change's headline artifact (proposal → design → first spec). */
function headlineTarget(change: OpenSpecChange): OpenSpecAnchorTarget | undefined {
  const base = `openspec/changes/${change.name}`;
  if (change.proposal) return { path: `${base}/proposal.md` };
  if (change.design) return { path: `${base}/design.md` };
  const firstDelta = change.specDeltas[0];
  if (firstDelta) return { path: `${base}/specs/${firstDelta.capability}/spec.md` };
  return undefined;
}

// ── anchor builders (pure, the single source of every Spec-view key + target) ──

export function changeAnchor(change: OpenSpecChange): OpenSpecReviewAnchor {
  return {
    kind: "change",
    key: changeKey(change.name),
    label: change.name,
    // The whole change ≈ its headline doc, path-grained (a change-wide comment).
    target: headlineTarget(change),
  };
}

export function capabilityAnchor(
  change: OpenSpecChange,
  note: OpenSpecCapabilityNote,
): OpenSpecReviewAnchor {
  return {
    kind: "capability",
    key: `${changeKey(change.name)}/capability/${slug(note.name)}`,
    label: note.name,
    target: targetFrom(change.name, note.source),
  };
}

export function whyBlockAnchor(change: OpenSpecChange, index: number): OpenSpecReviewAnchor {
  const block = change.proposal?.why[index];
  return {
    kind: "why-block",
    key: `${changeKey(change.name)}/proposal/why/${index}`,
    label: `why · block ${index + 1}`,
    target: targetFrom(change.name, block?.source),
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
    target: targetFrom(change.name, section.source),
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
    target: targetFrom(change.name, group.source),
  };
}

export function taskItemAnchor(
  change: OpenSpecChange,
  group: OpenSpecTaskGroup,
  item: OpenSpecTaskItem,
  index: number,
): OpenSpecReviewAnchor {
  return {
    kind: "task-item",
    key: `${changeKey(change.name)}/tasks/${group.id}/item/${index}`,
    label: item.text,
    target: targetFrom(change.name, item.source),
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
    target: targetFrom(change.name, delta.source),
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
    target: targetFrom(change.name, requirement.source),
  };
}

export function scenarioAnchor(
  change: OpenSpecChange,
  delta: OpenSpecSpecDelta,
  requirement: OpenSpecRequirement,
  scenarioName: string,
  source: OpenSpecSource | undefined,
): OpenSpecReviewAnchor {
  return {
    kind: "scenario",
    key: `${changeKey(change.name)}/spec/${slug(delta.capability)}/${slug(requirement.name)}/${slug(scenarioName)}`,
    label: scenarioName,
    target: targetFrom(change.name, source),
  };
}

// ── the render-ready view model ───────────────────────────────────────────────

/** One capability note plus whether it is new or modified, plus its anchor. */
export interface OpenSpecCapabilityView {
  readonly note: OpenSpecCapabilityNote;
  readonly nature: "new" | "modified";
  readonly anchor: OpenSpecReviewAnchor;
}

export type { OpenSpecRequirementCoverage } from "@rennet/protocol";

/**
 * The coverage index a build consumes: per-requirement coverage keyed by
 * `openSpecRequirementCoverageKey(capability, requirementName)` — the SAME key the
 * core producer emits its edges under, so neither side depends on the other's slug
 * logic. It is a PRODUCED artifact — a mapping runner's output — never inferred here;
 * the view attaches whatever the runner emitted for a requirement, or nothing when the
 * runner emitted nothing for it. Absent index entirely ⇒ coverage was not computed and
 * no chip renders; a present entry with `hunks.length === 0` is an honest computed zero
 * (`unimplemented`). These two must never collapse into one another.
 */
export type OpenSpecCoverageIndex = ReadonlyMap<string, OpenSpecRequirementCoverage>;

/** The chip a requirement's coverage renders as (absent ⇒ no chip). */
export type CoverageChip =
  | { readonly kind: "covered"; readonly hunks: readonly string[]; readonly tests: number }
  | { readonly kind: "unimplemented" };

/**
 * Classify a requirement's coverage into its chip, purely. Undefined coverage ⇒ no
 * chip (the mapping was not computed — never a fake `unimplemented`). Zero claiming
 * hunks ⇒ the honest `unimplemented` state (the computed zero). One or more ⇒ the
 * `covered` chip carrying the claiming hunks (the first is the jump target) and the
 * test count.
 */
export function classifyCoverage(
  coverage: OpenSpecRequirementCoverage | undefined,
): CoverageChip | undefined {
  if (!coverage) return undefined;
  if (coverage.hunks.length === 0) return { kind: "unimplemented" };
  return { kind: "covered", hunks: coverage.hunks, tests: coverage.tests };
}

export interface OpenSpecRequirementView {
  readonly requirement: OpenSpecRequirement;
  readonly anchor: OpenSpecReviewAnchor;
  /** Anchors for each scenario, index-aligned with `requirement.scenarios`. */
  readonly scenarioAnchors: readonly OpenSpecReviewAnchor[];
  /**
   * The requirement's produced coverage, when a mapping was computed for it. Absent
   * ⇒ no mapping (no chip); present with `hunks.length === 0` ⇒ honest `unimplemented`.
   */
  readonly coverage?: OpenSpecRequirementCoverage;
}

/** One delta operation group (ADDED / MODIFIED / …) with its requirements (issue #4). */
export interface OpenSpecDeltaGroupView {
  readonly operation: OpenSpecDeltaOperation;
  readonly requirements: readonly OpenSpecRequirementView[];
}

export interface OpenSpecDeltaView {
  readonly delta: OpenSpecSpecDelta;
  readonly anchor: OpenSpecReviewAnchor;
  /** Operation groups preserved (never flattened), so per-requirement operation is kept. */
  readonly groups: readonly OpenSpecDeltaGroupView[];
}

export interface OpenSpecDesignSectionView {
  readonly section: OpenSpecDesignSection;
  readonly anchor: OpenSpecReviewAnchor;
}

export interface OpenSpecTaskGroupView {
  readonly group: OpenSpecTaskGroup;
  readonly anchor: OpenSpecReviewAnchor;
  /** Anchors for each checklist item, index-aligned with `group.items`. */
  readonly itemAnchors: readonly OpenSpecReviewAnchor[];
}

export interface OpenSpecProposalView {
  readonly proposal: OpenSpecProposal;
  readonly capabilities: readonly OpenSpecCapabilityView[];
  /** Anchors for each Why block, index-aligned with `proposal.why`. */
  readonly whyAnchors: readonly OpenSpecReviewAnchor[];
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
  /** The verbatim raw artifact markdown (#239), for the one-keystroke raw view. */
  readonly raw?: OpenSpecChangeRaw;
}

/**
 * Fold a parsed change into the render-ready Spec view model: the structured
 * artifacts, each addressable element carrying a stable review anchor (structural
 * key + durable target), and a whole-change summary. A pure function of its inputs.
 *
 * `coverage` (optional) is the produced hunk↔requirement mapping (from the live
 * `runCoverageMapping` runner, over the `openspec.coverage` boundary), keyed by
 * `openSpecRequirementCoverageKey(capability, name)`: each requirement view is handed
 * exactly the coverage the runner emitted for it, or none. Omitting it (a host with no
 * producer, or a run that FAILED — the app passes it only on a completed `ok` mapping)
 * leaves every requirement's `coverage` absent, so the Spec view renders no chips
 * rather than a fabricated one.
 */
export function buildOpenSpecView(
  change: OpenSpecChange,
  coverage?: OpenSpecCoverageIndex,
): OpenSpecViewModel {
  const proposal: OpenSpecProposalView | undefined = change.proposal
    ? {
        proposal: change.proposal,
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
        whyAnchors: change.proposal.why.map((_block, index) => whyBlockAnchor(change, index)),
      }
    : undefined;

  const designSections: OpenSpecDesignSectionView[] = (change.design?.sections ?? []).map(
    (section) => ({ section, anchor: designSectionAnchor(change, section) }),
  );

  const taskGroups: OpenSpecTaskGroupView[] = (change.tasks?.groups ?? []).map((group) => ({
    group,
    anchor: taskGroupAnchor(change, group),
    itemAnchors: group.items.map((item, index) => taskItemAnchor(change, group, item, index)),
  }));

  const specDeltas: OpenSpecDeltaView[] = change.specDeltas.map((delta) => ({
    delta,
    anchor: specDeltaAnchor(change, delta),
    groups: delta.groups.map(
      (group): OpenSpecDeltaGroupView => ({
        operation: group.operation,
        requirements: group.requirements.map((requirement): OpenSpecRequirementView => {
          const anchor = requirementAnchor(change, delta, requirement);
          // Attach ONLY what the runner produced for this requirement, keyed by
          // (capability, name) — the same key the producer emits. Absent ⇒ no chip;
          // present-with-zero-hunks ⇒ honest unimplemented.
          const requirementCoverage = coverage?.get(
            openSpecRequirementCoverageKey(delta.capability, requirement.name),
          );
          return {
            requirement,
            anchor,
            scenarioAnchors: requirement.scenarios.map((scenario) =>
              scenarioAnchor(change, delta, requirement, scenario.name, scenario.source),
            ),
            ...(requirementCoverage ? { coverage: requirementCoverage } : {}),
          };
        }),
      }),
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
    ...(change.raw ? { raw: change.raw } : {}),
  };
}

/**
 * Author a disposition against a Spec-view anchor. When the anchor has a durable
 * `target` (the common case — the node carries a source), the write goes to the
 * REAL artifact file path at the node's line span, so the engine accepts it and it
 * persists; distinct nodes on one file carry distinct spans and never collide. With
 * no target (a source-less fixture) it degrades to the structural key path-grained
 * — honest, but non-durable. Either way it produces the IDENTICAL `DispositionWrite`
 * shape + `AuthoringTrace`, so a Spec disposition rides the same staging/publish
 * batch as any diff-lens one. `body` is the reviewer's sovereign text.
 */
export function authorOpenSpecDisposition(
  anchor: OpenSpecReviewAnchor,
  type: DispositionType,
  body = "",
): { writes: DispositionWrite[]; trace: AuthoringTrace } {
  const target = anchor.target;
  const write: DispositionWrite = target
    ? {
        path: target.path,
        type,
        body,
        ...(target.span && target.side ? { span: target.span, side: target.side } : {}),
      }
    : { path: anchor.key, type, body };
  // The trace `source` is the anchor identity (path + span), stable per node.
  return {
    writes: [write],
    trace: { granularity: "element", source: anchorPathKey(write), writes: [write] },
  };
}
