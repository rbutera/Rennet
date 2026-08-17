import {
  createInvocationBudget,
  DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
  reviewInvocationCeiling,
} from "@rennet/core";
import type { InvocationBudget, Review, ReviewHypothesis } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The per-review intelligence session (issue #316).
//
// A review turn has two entry points — the canvas flow (`buildCanvases`) and the
// flagged flow (`flaggedReview`) — that can run in either order or concurrently.
// Before this, each computed the committed hypothesis on its OWN InvocationBudget,
// so one review turn spent the hypothesis TWICE against TWO independent ceilings.
//
// This session collapses that: for a given `(reviewId, activePatchsetId)` there is
// ONE `InvocationBudget` and ONE hypothesis promise, shared by both flows. The
// hypothesis + the flagged dual seats + verification all debit the same counter, so
// the advertised "one per-review turn ceiling" is literally one budget instance.
//
// Key on `(reviewId, activePatchsetId)`: a reattach produces a new patchset id, so
// the hypothesis re-derives and the ceiling resets for the new review turn.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewIntelligenceSession {
  /** The single review-intelligence ceiling shared by both flows. */
  readonly budget: InvocationBudget;
  /** The committed hypothesis, computed exactly once per review turn. */
  readonly hypothesis: Promise<ReviewHypothesis | undefined>;
}

// ponytail: unbounded map per process lifetime — entries are droppable on review
// close; add eviction only if long sessions with many reviews measurably matter.
const sessions = new Map<string, ReviewIntelligenceSession>();

function sessionKey(review: Review): string {
  // NUL-joined so no id/patchset pair can collide with another via string overlap.
  return `${review.id}\u0000${review.activePatchsetId}`;
}

/**
 * Get (or lazily create) the intelligence session for a review turn. The first flow
 * to enter creates the budget and kicks off the hypothesis; the second reuses both.
 *
 * `computeHypothesis` is invoked at most once per `(reviewId, activePatchsetId)` and
 * is handed the shared budget so the hypothesis turn debits the same ceiling the
 * flagged seats do. The in-flight PROMISE is memoized — not the resolved value — so a
 * concurrent second flow awaits the first spend instead of double-spending.
 */
export function reviewIntelligenceSession(
  review: Review,
  deepReview: boolean,
  computeHypothesis: (budget: InvocationBudget) => Promise<ReviewHypothesis | undefined>,
): ReviewIntelligenceSession {
  const key = sessionKey(review);
  const existing = sessions.get(key);
  if (existing) return existing;

  const budget = createInvocationBudget(
    reviewInvocationCeiling(DEFAULT_REVIEW_INTELLIGENCE_BUDGET, deepReview),
  );
  const session: ReviewIntelligenceSession = { budget, hypothesis: computeHypothesis(budget) };
  sessions.set(key, session);
  return session;
}

/** Test-only: clear the process-local session map between cases. */
export function __resetReviewIntelligenceSessions(): void {
  sessions.clear();
}
