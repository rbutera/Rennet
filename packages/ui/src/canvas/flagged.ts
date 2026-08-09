import type {
  FindingAgreement,
  FindingElement,
  FindingModelAnswer,
  FindingSeverity,
  FlaggedReview,
} from "@rennet/types";

/**
 * The Flagged lens, pure derivation (issue #138).
 *
 * The Flagged lens is ONE index over everything the automated review layer raised:
 * model-council findings plus dual-review agreement/disagreement, each with a
 * severity and an anchor. This module folds a review's `FlaggedReview` input into
 * an ordered, host-free `FlaggedIndex` the surface renders — severity ordering,
 * agreement normalisation, the empty-vs-failed distinction, and the guard that a
 * validator rejection is never surfaced as a flag. It is deliberately host-free
 * (`@rennet/ui` imports only types + protocol) so every rule here is unit-testable
 * without Electron.
 *
 * The rules, from the issue:
 *   • ONE index over findings; each row carries severity, agreement, and an anchor.
 *   • The lens POINTS at the mark at its anchor — it is an index, not a house.
 *   • Ordered high → medium → low, then by findingId, so it is a pure function of
 *     the finding SET (input order never matters).
 *   • Disagreement renders each model's answer side by side, labelled, HERE in the
 *     index — never as a synthesis block or a chat interruption.
 *   • A review that ran and found nothing is honestly EMPTY, distinguishable from a
 *     runner that FAILED.
 *   • `rejectedItems` (malformed RSP items the validator dropped) are NEVER flags.
 */

export type { FindingAgreement, FindingModelAnswer, FindingSeverity } from "@rennet/types";

/** One row in the flagged index: the flag, its severity, agreement, and anchor. */
export interface FlaggedRow {
  findingId: string;
  severity: FindingSeverity;
  summary: string;
  /** The mark this row points at; the lens jumps here, it does not own the mark. */
  anchor: string;
  agreement: FindingAgreement;
}

/**
 * The derived flagged index. `failed` is a runner that did not complete — a
 * distinct state from `ok` with zero rows (a review that ran and flagged nothing).
 * The surface must render these two differently; conflating them would tell the
 * user "all clear" when the truth is "we could not check".
 */
export type FlaggedIndex =
  | { state: "failed"; reason: string }
  | {
      state: "ok";
      rows: FlaggedRow[];
      /** Per-severity counts over the placed rows (for the lens header chips). */
      counts: Record<FindingSeverity, number>;
      total: number;
    };

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return value === "high" || value === "medium" || value === "low";
}

function isModelAnswer(value: unknown): value is FindingModelAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string" &&
    typeof (value as { answer?: unknown }).answer === "string"
  );
}

function isAgreement(value: unknown): value is FindingAgreement {
  if (typeof value !== "object" || value === null) return false;
  const agreement = value as Record<string, unknown>;
  if (agreement.kind === "concur") {
    return typeof agreement.agree === "number" && typeof agreement.total === "number";
  }
  if (agreement.kind === "disagree") {
    return Array.isArray(agreement.answers) && agreement.answers.every(isModelAnswer);
  }
  return false;
}

/**
 * The STRICT finding guard — the surface half of "never repurpose validator
 * rejections as findings". A `rejectedItems` entry is a malformed RSP item the
 * validator dropped; it is shaped nothing like a finding, so it fails here and is
 * never rendered as a flag. Belt and braces with the core projector's guard.
 */
export function isFinding(value: unknown): value is FindingElement {
  if (typeof value !== "object" || value === null) return false;
  const finding = value as Record<string, unknown>;
  return (
    typeof finding.findingId === "string" &&
    typeof finding.anchor === "string" &&
    typeof finding.summary === "string" &&
    isFindingSeverity(finding.severity) &&
    isAgreement(finding.agreement)
  );
}

/** A total, locale-independent order (UTF-16 code units), matching core's ordering. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRow(finding: FindingElement): FlaggedRow {
  return {
    findingId: finding.findingId,
    severity: finding.severity,
    summary: finding.summary,
    anchor: finding.anchor,
    agreement: finding.agreement,
  };
}

/** Fold a review's flagged input into the ordered index the surface renders. */
export function buildFlaggedIndex(review: FlaggedReview): FlaggedIndex {
  if (review.status === "failed") {
    return { state: "failed", reason: review.reason };
  }
  // Defensive: a host or fixture that hands back a malformed input (no findings
  // array) must not crash the lens — treat it as an empty, honest read.
  const findings = Array.isArray(review.findings) ? review.findings : [];
  // The guard is load-bearing: only well-formed findings become rows, so a
  // validator rejection (or any malformed item) can never surface as a flag.
  const rows = findings
    .filter(isFinding)
    .map(toRow)
    .sort(
      (left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        compareCodeUnits(left.findingId, right.findingId),
    );
  const counts: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const row of rows) counts[row.severity] += 1;
  return { state: "ok", rows, counts, total: rows.length };
}
