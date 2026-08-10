import type {
  FindingSeverity,
  HypothesisScope,
  ReviewHypothesis,
  RiskCrossCheck,
} from "@rennet/types";

/**
 * The hypothesis reading-frame, pure derivation (issue #178).
 *
 * The committed hypothesis is the human's reading frame — what this change SHOULD
 * be and what to worry about, shown BEFORE the lenses so the reviewer reads with a
 * prior rather than rubber-stamping the diff. This module folds a `ReviewHypothesis`
 * plus its predicted-risk cross-check into an ordered, host-free `HypothesisFrame`
 * the surface renders: the domain, the in/out scope, the design expectation, and
 * the risk list — each risk carrying its confirmed/open status and the findings it
 * links to.
 *
 * Two rules are load-bearing:
 *   • An OPEN risk (predicted-but-unflagged) is the anti-rubber-stamp payoff — a
 *     risk the reviewer must check themselves. It is ordered FIRST within its
 *     severity so the human's attention lands on the un-cleared risks.
 *   • A risk with no matching cross-check defaults to OPEN, never confirmed — the
 *     safe direction (a false "confirmed" would hide an unchecked risk; a false
 *     "open" merely asks for a re-check). Deleting the cross-check cannot silence a
 *     risk into looking handled.
 *
 * It is deliberately host-free (`@rennet/ui` imports only types) so every rule here
 * is unit-testable without Electron.
 */

/** One risk row on the reading frame: the risk plus its cross-check disposition. */
export interface HypothesisFrameRisk {
  riskId: string;
  statement: string;
  severity: FindingSeverity;
  disconfirmer: string;
  /** `confirmed` — a finding addressed it; `open` — the human must check it themselves. */
  status: "confirmed" | "open";
  /** The findings that addressed this risk (empty when open). */
  findingIds: string[];
}

/** The derived reading frame the surface renders before the lenses. */
export interface HypothesisFrame {
  domain: string;
  scope: HypothesisScope;
  designExpectation: string;
  risks: HypothesisFrameRisk[];
  /** False when the prior was formed without the ProjectSnapshot (an honest degradation badge). */
  repoContextPresent: boolean;
  /** Counts over the placed risks (for the frame header). */
  counts: { confirmed: number; open: number };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** A total, locale-independent order (UTF-16 code units), matching the other lenses. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fold a committed hypothesis + its risk cross-check into the ordered reading
 * frame the surface renders. Risks are ordered by severity (high → medium → low),
 * then OPEN before confirmed within a severity (the un-cleared risks first, where
 * the human's attention should go), then by riskId — a pure function of the input
 * set, independent of input order. A risk absent from the cross-check defaults to
 * open (never confirmed), so a missing or partial cross-check can never make a
 * risk look handled.
 */
export function buildHypothesisFrame(
  hypothesis: ReviewHypothesis,
  crossChecks: readonly RiskCrossCheck[],
): HypothesisFrame {
  const byRisk = new Map<string, RiskCrossCheck>();
  for (const crossCheck of crossChecks) byRisk.set(crossCheck.riskId, crossCheck);

  const risks: HypothesisFrameRisk[] = hypothesis.risks
    .map((risk): HypothesisFrameRisk => {
      const crossCheck = byRisk.get(risk.riskId);
      // Absent cross-check ⇒ open (the safe default: never fabricate "confirmed").
      const status = crossCheck?.status === "confirmed" ? "confirmed" : "open";
      return {
        riskId: risk.riskId,
        statement: risk.statement,
        severity: risk.severity,
        disconfirmer: risk.disconfirmer,
        status,
        findingIds: status === "confirmed" ? [...(crossCheck?.findingIds ?? [])] : [],
      };
    })
    .sort(
      (left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        // Open before confirmed within a severity — the un-cleared risks first.
        (left.status === right.status ? 0 : left.status === "open" ? -1 : 1) ||
        compareCodeUnits(left.riskId, right.riskId),
    );

  const counts = { confirmed: 0, open: 0 };
  for (const risk of risks) counts[risk.status] += 1;

  return {
    domain: hypothesis.domain,
    scope: hypothesis.scope,
    designExpectation: hypothesis.designExpectation,
    risks,
    repoContextPresent: hypothesis.repoContextPresent,
    counts,
  };
}
