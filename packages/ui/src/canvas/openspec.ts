import type {
  Disposition,
  DispositionType,
  OpenSpecChange,
  OpenSpecProseSection,
  OpenSpecReviewAnchor,
} from "@rennet/types";
import type { DispositionWrite } from "./logic";

// ─────────────────────────────────────────────────────────────────────────────
// The OpenSpec change view, pure derivation + the review-authoring seam (#15).
//
// The parser (`@rennet/core parseOpenSpecChange`) produces an `OpenSpecChange` whose
// every node already carries a structural `OpenSpecReviewAnchor`. This module folds
// that tree into a render-ready `OpenSpecView`: the flat anchor index in document
// order (the keying spine), the reviewer's dispositions keyed to those anchors, and
// the task-progress roll-up the header shows. `authorOpenSpecDisposition` is the
// review seam — it turns a disposition on a node into the same `DispositionWrite`
// (`{ path, type, body }`) the code-review surface emits, so an OpenSpec review
// rides the existing disposition machinery unchanged. The write's `path` is the
// node's STRUCTURAL anchor id (`spec:cap/operations/0/requirements/1`), never a
// line, so a comment survives a re-parse and prose edits above it.
//
// Host-free (`@rennet/ui` imports only types), so every rule here is unit-testable
// without Electron.
// ─────────────────────────────────────────────────────────────────────────────

/** The task-checklist roll-up shown in the view header. */
export interface OpenSpecTaskProgress {
  readonly total: number;
  readonly completed: number;
  /** `completed / total`, or 0 when there are no tasks. */
  readonly ratio: number;
}

/** The render-ready view over one parsed change plus the reviewer's dispositions. */
export interface OpenSpecViewModel {
  readonly change: OpenSpecChange;
  /** Every reviewable anchor in document order — the keying spine. */
  readonly anchors: readonly OpenSpecReviewAnchor[];
  /** `anchor.id` → the dispositions authored against it (only anchors on THIS change). */
  readonly dispositionsByAnchor: ReadonlyMap<string, readonly Disposition[]>;
  readonly taskProgress: OpenSpecTaskProgress;
  /** Dispositions that matched a node on this change (the header count). */
  readonly dispositionCount: number;
}

/** Walk a prose section and its subsections, collecting anchors in document order. */
function collectProse(section: OpenSpecProseSection, into: OpenSpecReviewAnchor[]): void {
  into.push(section.anchor);
  for (const child of section.subsections ?? []) collectProse(child, into);
}

/**
 * Every reviewable anchor of a change, in document order: the four artifacts, then
 * proposal (its sections + each capability delta + any extra sections), the design
 * sections (recursively), the task groups + items, and each spec delta down to its
 * scenarios. This is the order the view renders and the spine the keying map covers.
 */
export function openSpecAnchors(change: OpenSpecChange): OpenSpecReviewAnchor[] {
  const anchors: OpenSpecReviewAnchor[] = [];

  anchors.push(change.proposal.anchor);
  collectProse(change.proposal.why, anchors);
  collectProse(change.proposal.whatChanges, anchors);
  for (const capability of change.proposal.capabilities) anchors.push(capability.anchor);
  collectProse(change.proposal.impact, anchors);
  for (const extra of change.proposal.extraSections ?? []) collectProse(extra, anchors);

  if (change.design) {
    anchors.push(change.design.anchor);
    for (const section of change.design.sections) collectProse(section, anchors);
  }

  anchors.push(change.tasks.anchor);
  for (const group of change.tasks.groups) {
    anchors.push(group.anchor);
    for (const item of group.items) anchors.push(item.anchor);
  }

  for (const delta of change.specDeltas) {
    anchors.push(delta.anchor);
    for (const operation of delta.operations) {
      anchors.push(operation.anchor);
      for (const requirement of operation.requirements) {
        anchors.push(requirement.anchor);
        for (const scenario of requirement.scenarios) anchors.push(scenario.anchor);
      }
    }
  }

  return anchors;
}

/**
 * Fold a parsed change plus the reviewer's dispositions into the render-ready view.
 * A disposition is keyed to a node when its anchor `path` equals a node's anchor
 * `id` (the structural address the writes were authored against); dispositions that
 * match no node on this change are ignored, so a stale or foreign disposition never
 * attaches. Deterministic: keys follow document order.
 */
export function buildOpenSpecView(
  change: OpenSpecChange,
  dispositions: readonly Disposition[] = [],
): OpenSpecViewModel {
  const anchors = openSpecAnchors(change);
  const known = new Set(anchors.map((anchor) => anchor.id));

  const grouped = new Map<string, Disposition[]>();
  let dispositionCount = 0;
  for (const disposition of dispositions) {
    const key = disposition.anchor.path;
    if (!known.has(key)) continue;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(disposition);
    else grouped.set(key, [disposition]);
    dispositionCount += 1;
  }

  const total = change.tasks.total;
  const completed = change.tasks.completed;
  const taskProgress: OpenSpecTaskProgress = {
    total,
    completed,
    ratio: total > 0 ? completed / total : 0,
  };

  return {
    change,
    anchors,
    dispositionsByAnchor: grouped,
    taskProgress,
    dispositionCount,
  };
}

/** The dispositions keyed to one anchor (empty when none). */
export function dispositionsForAnchor(
  view: OpenSpecViewModel,
  anchor: OpenSpecReviewAnchor,
): readonly Disposition[] {
  return view.dispositionsByAnchor.get(anchor.id) ?? [];
}

/**
 * The review seam: author a disposition against an OpenSpec node. The write's
 * `path` is the node's STRUCTURAL anchor id (never a line), so the disposition
 * carries across a re-parse. `body` defaults to empty — the reviewer's sovereign
 * text is added by the existing raw-draft batch (the `DispositionDraft.raw` seam),
 * exactly as the code-review surface stages a bare verb before refinement.
 */
export function authorOpenSpecDisposition(
  anchor: OpenSpecReviewAnchor,
  type: DispositionType,
  body = "",
): DispositionWrite {
  return { path: anchor.id, type, body };
}
