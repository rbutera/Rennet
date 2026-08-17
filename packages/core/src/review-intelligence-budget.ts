import { normalizeMaxInvocations } from "./invocation-budget";

export type ReviewIntelligenceLens = "flagged" | "decisions" | "noise";

export interface ReviewIntelligenceBudget {
  readonly totalInvocations: number;
  readonly quickReviewInvocations: number;
  readonly hypothesis: {
    readonly maxTurns: number;
  };
  readonly dualModel: {
    readonly enabled: boolean;
    readonly lenses: readonly ReviewIntelligenceLens[];
  };
  readonly verification: {
    readonly maxVerifications: number;
    readonly batchSize: number;
  };
  readonly adjudication: {
    /** Max contested (disagree) rows adjudicated per review; the rest surface capped. */
    readonly maxAdjudications: number;
  };
  readonly uiVerification: {
    /** Max verify-ui turns per review (issue #183); the frozen default is 1. */
    readonly maxTurns: number;
  };
}

export const DEFAULT_REVIEW_INTELLIGENCE_BUDGET: ReviewIntelligenceBudget = Object.freeze({
  totalInvocations: 12,
  quickReviewInvocations: 6,
  hypothesis: Object.freeze({ maxTurns: 1 }),
  dualModel: Object.freeze({ enabled: true, lenses: Object.freeze(["flagged"] as const) }),
  verification: Object.freeze({ maxVerifications: 6, batchSize: 3 }),
  adjudication: Object.freeze({ maxAdjudications: 4 }),
  uiVerification: Object.freeze({ maxTurns: 1 }),
});

export function reviewInvocationCeiling(
  budget: ReviewIntelligenceBudget,
  deepReviewOn: boolean,
): number {
  return normalizeMaxInvocations(
    deepReviewOn ? budget.totalInvocations : budget.quickReviewInvocations,
  );
}
