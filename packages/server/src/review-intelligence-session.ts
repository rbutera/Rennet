import {
  createInvocationBudget,
  DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
  reviewInvocationCeiling,
} from "@rennet/core";
import type { InvocationBudget, Review } from "@rennet/protocol";

export type ReviewIntelligenceFlow = "canvases" | "flagged";

export interface ReviewIntelligenceSession {
  readonly budget: InvocationBudget;
  readonly deepReview: boolean;
}

interface MutableSession extends ReviewIntelligenceSession {
  readonly enteredFlows: Set<ReviewIntelligenceFlow>;
}

export interface ReviewIntelligenceSessions {
  enter(
    review: Review,
    deepReview: boolean,
    flow: ReviewIntelligenceFlow,
  ): ReviewIntelligenceSession;
}

function sessionKey(review: Review): string {
  return `${review.id}\u0000${review.activePatchsetId}`;
}

function createSession(deepReview: boolean, flow: ReviewIntelligenceFlow): MutableSession {
  const budget = createInvocationBudget(
    reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, deepReview),
  );

  return {
    budget,
    deepReview,
    enteredFlows: new Set([flow]),
  };
}

/**
 * Pair the canvas and flagged dispatches for one review turn. Re-entering either
 * flow starts a fresh turn; the other flow may join it exactly once. Once both
 * flows have joined, the coordinator drops the entry while each running pipeline
 * retains the shared session object.
 */
export function createReviewIntelligenceSessions(): ReviewIntelligenceSessions {
  const sessions = new Map<string, MutableSession>();

  return {
    enter(review, deepReview, flow) {
      const key = sessionKey(review);
      const existing = sessions.get(key);

      if (existing && existing.deepReview === deepReview && !existing.enteredFlows.has(flow)) {
        existing.enteredFlows.add(flow);
        sessions.delete(key);
        return existing;
      }

      const fresh = createSession(deepReview, flow);
      sessions.set(key, fresh);
      return fresh;
    },
  };
}
