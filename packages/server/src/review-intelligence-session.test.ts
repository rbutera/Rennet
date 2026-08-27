import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createReviewIntelligenceSessions } from "./review-intelligence-session";

function fakeReview(id: string, activePatchsetId: string): Review {
  return { id, activePatchsetId } as unknown as Review;
}

describe("review intelligence turn lifecycle (#316)", () => {
  it("shares one provisional canvas session with the first same-mode flagged turn", () => {
    const sessions = createReviewIntelligenceSessions();
    const review = fakeReview("rv_1", "ps_1");
    const canvas = sessions.enter(review, true, "canvases");
    const flagged = sessions.enter(review, true, "flagged");
    expect(flagged).toBe(canvas);
    expect(flagged.budget).toBe(canvas.budget);
    expect(flagged.budget.max).toBe(12);
  });

  it("same-key quick to dual re-entry starts a fresh budget with the correct ceiling", () => {
    const sessions = createReviewIntelligenceSessions();
    const review = fakeReview("rv_toggle", "ps_1");
    const quick = sessions.enter(review, false, "flagged");
    quick.budget.tryConsume("quick");
    const dual = sessions.enter(review, true, "flagged");
    expect(dual).not.toBe(quick);
    expect(dual.budget).not.toBe(quick.budget);
    expect(quick.budget.max).toBe(6);
    expect(quick.budget.consumed).toBe(1);
    expect(dual.budget.max).toBe(12);
    expect(dual.budget.consumed).toBe(0);
  });

  it("same-key canvas retry starts a fresh budget instead of reusing the failed turn", () => {
    const sessions = createReviewIntelligenceSessions();
    const review = fakeReview("rv_retry_canvas", "ps_1");
    const failed = sessions.enter(review, false, "canvases");
    failed.budget.tryConsume("failed-canvas");
    const retry = sessions.enter(review, false, "canvases");
    expect(retry).not.toBe(failed);
    expect(retry.budget).not.toBe(failed.budget);
    expect(retry.budget.max).toBe(6);
    expect(retry.budget.consumed).toBe(0);
  });

  it("a new patchset starts a fresh turn", () => {
    const sessions = createReviewIntelligenceSessions();
    const first = sessions.enter(fakeReview("rv_1", "ps_1"), true, "flagged");
    const reattached = sessions.enter(fakeReview("rv_1", "ps_2"), true, "flagged");
    expect(reattached).not.toBe(first);
    expect(reattached.budget).not.toBe(first.budget);
  });
});
