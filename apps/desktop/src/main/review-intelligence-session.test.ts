import type { InvocationBudget, Review, ReviewHypothesis } from "@rennet/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetReviewIntelligenceSessions,
  reviewIntelligenceSession,
} from "./review-intelligence-session";

// The session reads only `id` and `activePatchsetId`; a partial cast keeps the unit
// honest without constructing an entire Review fixture.
function fakeReview(id: string, activePatchsetId: string): Review {
  return { id, activePatchsetId } as unknown as Review;
}

describe("reviewIntelligenceSession (#316)", () => {
  beforeEach(() => {
    __resetReviewIntelligenceSessions();
  });

  it("computes the hypothesis ONCE and shares ONE budget across both flows", async () => {
    const review = fakeReview("rv_1", "ps_1");
    let computeCalls = 0;
    const compute = (budget: InvocationBudget): Promise<ReviewHypothesis | undefined> => {
      computeCalls += 1;
      budget.tryConsume("hypothesis"); // the one hypothesis turn debits the shared ceiling
      return Promise.resolve(undefined);
    };

    // The canvas flow enters first, the flagged flow second — the SAME review turn.
    // Before #316 each flow computed the hypothesis on its own ceiling (two spends);
    // the shared session collapses that to one turn on one budget.
    const canvas = reviewIntelligenceSession(review, true, compute);
    const flagged = reviewIntelligenceSession(review, true, compute);
    await Promise.all([canvas.hypothesis, flagged.hypothesis]);

    expect(computeCalls).toBe(1); // one hypothesis turn, not two (the #316 double-spend)
    expect(flagged.budget).toBe(canvas.budget); // one shared ceiling INSTANCE
    expect(canvas.budget.consumed).toBe(1); // a single debit on the shared budget
  });

  it("memoizes the in-flight promise so a concurrent flow awaits the first spend", async () => {
    const review = fakeReview("rv_conc", "ps_1");
    let resolve: ((value: ReviewHypothesis | undefined) => void) | undefined;
    let computeCalls = 0;
    const compute = (): Promise<ReviewHypothesis | undefined> => {
      computeCalls += 1;
      return new Promise((r) => {
        resolve = r;
      });
    };
    const a = reviewIntelligenceSession(review, true, compute);
    const b = reviewIntelligenceSession(review, true, compute); // enters while a is in flight
    expect(b.hypothesis).toBe(a.hypothesis); // same in-flight promise
    expect(computeCalls).toBe(1);
    resolve?.(undefined);
    await Promise.all([a.hypothesis, b.hypothesis]);
  });

  it("a reattach (new active patchset) re-derives the hypothesis and resets the ceiling", () => {
    let computeCalls = 0;
    const compute = (): Promise<ReviewHypothesis | undefined> => {
      computeCalls += 1;
      return Promise.resolve(undefined);
    };
    const first = reviewIntelligenceSession(fakeReview("rv_1", "ps_1"), true, compute);
    const reattached = reviewIntelligenceSession(fakeReview("rv_1", "ps_2"), true, compute);
    expect(reattached).not.toBe(first);
    expect(reattached.budget).not.toBe(first.budget); // the ceiling resets for the new turn
    expect(computeCalls).toBe(2); // a new patchset re-derives, never reuses
  });

  it("the ceiling reflects the deep/quick mode at first entry", () => {
    const deep = reviewIntelligenceSession(fakeReview("rv_deep", "ps"), true, () =>
      Promise.resolve(undefined),
    );
    const quick = reviewIntelligenceSession(fakeReview("rv_quick", "ps"), false, () =>
      Promise.resolve(undefined),
    );
    expect(deep.budget.max).toBe(12); // DEFAULT_REVIEW_INTELLIGENCE_BUDGET.totalInvocations
    expect(quick.budget.max).toBe(6); // .quickReviewInvocations
  });
});
