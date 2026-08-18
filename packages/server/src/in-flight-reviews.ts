// Which reviews have a model turn running right now (#383 batch, finding 2). This is the
// real source of the projected review's `attention.running` — NOT `pendingPatchsetId`, which
// means "the working tree moved, this review is stale" (invalidation), a different fact.
//
// A review-scoped turn (regenerate / refine / handoff.run / ask / re-capture) ENTERS on start
// and LEAVES in a `finally`, so the set holds exactly the reviews whose turn is in flight.
// Counted, because two turns can overlap on one review (an ask while a regenerate runs); the
// review stops being "running" only when the LAST turn on it settles.

export class InFlightReviews {
  readonly #counts = new Map<string, number>();

  /** A turn on this review started. */
  enter(reviewId: string): void {
    this.#counts.set(reviewId, (this.#counts.get(reviewId) ?? 0) + 1);
  }

  /** A turn on this review settled (completed / errored / aborted). Idempotent past zero. */
  leave(reviewId: string): void {
    const next = (this.#counts.get(reviewId) ?? 0) - 1;
    if (next <= 0) this.#counts.delete(reviewId);
    else this.#counts.set(reviewId, next);
  }

  /** Is a turn in flight on this review right now? */
  has(reviewId: string): boolean {
    return this.#counts.has(reviewId);
  }
}
