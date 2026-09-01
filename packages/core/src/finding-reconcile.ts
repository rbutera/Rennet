/**
 * Reconcile two seats' findings into one flagged set (issue #41).
 *
 * Dual-model review runs the SAME finding lens twice — once per provider seat
 * (Claude, Codex) — INDEPENDENTLY. Neither seat sees the other's output. This
 * module folds the two grounded `FindingElement[]` sets into ONE, populating each
 * row's `agreement`:
 *
 *   • concur   — both seats flagged the same location with comparable severity.
 *   • disagree — one seat flagged it and the other did not (a SOLO), OR both
 *                flagged the same location with materially different verdicts
 *                (a CONFLICT). Each seat's own words ride side by side, labelled.
 *
 * The load-bearing invariant (Rai, #139/#41): reconcile is ARITHMETIC over anchors
 * and severities and NEVER mints a third, merged summary. A `concur` row keeps ONE
 * seat's verbatim summary (the clearer one); a `disagree` row carries BOTH seats'
 * verbatim answers. There is no code path that concatenates or paraphrases two
 * findings into a synthesised verdict — disagreement is surfaced as its own signal,
 * never averaged into a bland consensus.
 *
 * It is a pure function (no I/O, no model turn, no clock), so it is exhaustively
 * unit-testable: concur match, solo → disagree, conflict → disagree, and the
 * red-then-green proof that no reconciled summary is a merge of the two inputs.
 */

import type {
  FindingAgreement,
  FindingElement,
  FindingModelAnswer,
  FindingSeverity,
  ParsedAnchor,
} from "@rennet/protocol";
import { parseAnchor } from "@rennet/protocol";

/** The provider labels for the two seats, shown beside each disagreement answer. */
export interface ReconcileLabels {
  /** Seat A's label, e.g. "Claude". Rendered first in every side-by-side. */
  readonly a: string;
  /** Seat B's label, e.g. "Codex". Rendered second in every side-by-side. */
  readonly b: string;
}

/** The disagreement answer for a seat that raised no concern at the anchor. */
export const NO_CONCERN_ANSWER = "no concern raised here";

/**
 * How close two spans must be (in lines) to count as the SAME location. Two seats
 * rarely anchor a shared concern to the byte-identical line, so a small window
 * folds "the same bug, off by a line or two" into one row rather than two solos.
 */
export const DEFAULT_ANCHOR_PROXIMITY = 3;

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** The higher of two severities (high > medium > low). */
function higherSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/**
 * Comparable ⇒ the two seats agree closely enough to CONCUR. Equal or adjacent
 * severity (rank distance ≤ 1) is comparable; only the extremes (high vs low, a
 * rank distance of 2) are a MATERIALLY different verdict and become a conflict.
 */
function comparableSeverity(a: FindingSeverity, b: FindingSeverity): boolean {
  return Math.abs(SEVERITY_RANK[a] - SEVERITY_RANK[b]) <= 1;
}

/** A total, locale-independent order (UTF-16 code units), matching the lens's. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function spanOf(anchor: ParsedAnchor): Span | undefined {
  if (anchor.span === undefined) return undefined;
  return { start: anchor.span.startLine, end: anchor.span.endLine ?? anchor.span.startLine };
}

/** The line-gap between two spans; 0 when they overlap or touch. */
function spanGap(a: Span, b: Span): number {
  if (a.end < b.start) return b.start - a.end;
  if (b.end < a.start) return a.start - b.end;
  return 0;
}

/**
 * True iff two anchors point at the SAME location: same kind + same offered id,
 * a compatible side, and (when both carry spans) spans within `proximity` lines.
 * A malformed anchor never matches (findings are pre-culled to grounded anchors,
 * so this is defensive). One span-less anchor against a spanned one matches — the
 * whole unit contains the line.
 */
function sameLocation(rawA: string, rawB: string, proximity: number): boolean {
  const parsedA = parseAnchor(rawA);
  const parsedB = parseAnchor(rawB);
  if (!parsedA.ok || !parsedB.ok) return false;
  const a = parsedA.anchor;
  const b = parsedB.anchor;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  // Different explicit sides of the diff are different locations; an absent side
  // on either is treated as compatible (it addresses the unit, not a side).
  if (a.side !== undefined && b.side !== undefined && a.side !== b.side) return false;
  const spanA = spanOf(a);
  const spanB = spanOf(b);
  if (spanA === undefined || spanB === undefined) return true;
  return spanGap(spanA, spanB) <= proximity;
}

/** The trimmed length is the "clearer" proxy — more said, more the reviewer sees. */
function isClearer(candidate: FindingElement, incumbent: FindingElement): boolean {
  const cLen = candidate.summary.trim().length;
  const iLen = incumbent.summary.trim().length;
  if (cLen !== iLen) return cLen > iLen;
  // Deterministic tie-break so reconcile is a pure function of the finding SET.
  return compareCodeUnits(candidate.findingId, incumbent.findingId) < 0;
}

function concur(agree: number, total: number): FindingAgreement {
  return { kind: "concur", agree, total };
}

function disagree(answers: FindingModelAnswer[]): FindingAgreement {
  return { kind: "disagree", answers };
}

/**
 * Fold two seats' independently-produced findings into one reconciled set.
 *
 * @param seatAFindings the first seat's grounded findings (each `concur 1/1`).
 * @param seatBFindings the second seat's grounded findings (each `concur 1/1`).
 * @param labels        the provider labels for the two seats (A rendered first).
 * @param proximity     the line window for the anchor match (default 3).
 *
 * Never produces a merged summary. Every row's `summary` is ONE seat's verbatim words: the
 * clearer seat's on a concur, seat A's on a conflict, the raising seat's on a solo. The
 * other seat's answer is not lost — a `disagree` agreement carries both verbatim, side by
 * side, and the board stamps the row `conflict` so a reader is not shown a disagreement
 * wearing the arithmetic of agreement.
 */
export function reconcileFindings(
  seatAFindings: readonly FindingElement[],
  seatBFindings: readonly FindingElement[],
  labels: ReconcileLabels,
  proximity: number = DEFAULT_ANCHOR_PROXIMITY,
): FindingElement[] {
  return reconcileFindingsWithProvenance(seatAFindings, seatBFindings, labels, proximity).map(
    ({ finding }) => finding,
  );
}

/** One reconciled row plus the seat finding ids it consumed. */
export interface ReconciledFinding {
  readonly finding: FindingElement;
  /**
   * Seat finding ids this row CONSUMED — every id that was matched into this one and is
   * gone from the reconciled set. Both matched arms populate it: a CONCUR keeps the clearer
   * seat's id and consumes the other's, and a CONFLICT keeps seat A's id (carrying both
   * seats' verbatim answers in its `agreement`, stamped `conflict`) and consumes seat B's.
   * Only a solo — one seat raised it, the other did not — consumes nothing.
   *
   * A caller holding the two seats' boards needs this: an element citing the consumed id
   * would otherwise dangle, and only the matcher knows which surviving row it meant.
   * Derived here rather than re-matched by a caller, because the pairing is greedy and
   * order-sensitive — a second implementation of it would silently disagree.
   */
  readonly superseded: readonly string[];
}

/** {@link reconcileFindings}, keeping which seat ids each row consumed. */
export function reconcileFindingsWithProvenance(
  seatAFindings: readonly FindingElement[],
  seatBFindings: readonly FindingElement[],
  labels: ReconcileLabels,
  proximity: number = DEFAULT_ANCHOR_PROXIMITY,
): ReconciledFinding[] {
  const out: ReconciledFinding[] = [];
  const matchedB = new Set<number>();

  for (const a of seatAFindings) {
    // First unmatched B at the same location wins (greedy; A-order stable).
    let partnerIndex = -1;
    for (let i = 0; i < seatBFindings.length; i += 1) {
      if (matchedB.has(i)) continue;
      const b = seatBFindings[i];
      if (b !== undefined && sameLocation(a.anchor, b.anchor, proximity)) {
        partnerIndex = i;
        break;
      }
    }

    if (partnerIndex === -1) {
      // Solo A: seat A raised it, seat B did not.
      out.push({
        finding: {
          findingId: a.findingId,
          anchor: a.anchor,
          summary: a.summary,
          severity: a.severity,
          agreement: disagree([
            { model: labels.a, answer: a.summary },
            { model: labels.b, answer: NO_CONCERN_ANSWER },
          ]),
        },
        superseded: [],
      });
      continue;
    }

    const b = seatBFindings[partnerIndex] as FindingElement;
    matchedB.add(partnerIndex);
    const severity = higherSeverity(a.severity, b.severity);

    if (comparableSeverity(a.severity, b.severity)) {
      // Concur: keep the clearer summary (and its id/anchor) plus the higher
      // severity. This is a SELECTION of one seat's words, never a merge.
      const kept = isClearer(b, a) ? b : a;
      const dropped = kept === b ? a : b;
      out.push({
        finding: {
          findingId: kept.findingId,
          anchor: kept.anchor,
          summary: kept.summary,
          severity,
          agreement: concur(2, 2),
        },
        // The other seat's finding is gone from the merged set; whoever cited it must be
        // repointed at the row that kept it.
        superseded: dropped.findingId === kept.findingId ? [] : [dropped.findingId],
      });
    } else {
      // Conflict: same location, materially different verdict → both verbatim.
      out.push({
        finding: {
          findingId: a.findingId,
          anchor: a.anchor,
          summary: a.summary,
          severity,
          agreement: disagree([
            { model: labels.a, answer: a.summary },
            { model: labels.b, answer: b.summary },
          ]),
        },
        superseded: b.findingId === a.findingId ? [] : [b.findingId],
      });
    }
  }

  // Solo B: seat B raised it, seat A did not.
  for (let i = 0; i < seatBFindings.length; i += 1) {
    if (matchedB.has(i)) continue;
    const b = seatBFindings[i];
    if (b === undefined) continue;
    out.push({
      finding: {
        findingId: b.findingId,
        anchor: b.anchor,
        summary: b.summary,
        severity: b.severity,
        agreement: disagree([
          { model: labels.a, answer: NO_CONCERN_ANSWER },
          { model: labels.b, answer: b.summary },
        ]),
      },
      superseded: [],
    });
  }

  return out;
}
