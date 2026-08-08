import type { NarrativeProgressEvent } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// NarrativeProgressFeed (issue #71)
//
// The stage-three live narrative is delivered through the same R35 discipline as
// canvas invalidations: a tiny typed emitter, ordered by the pipeline's sequence,
// bounded by stable per-line keys, and with an explicit subscription lifetime.
// The history is the resumable projection; the feed is never a second source of
// review truth and it never transports raw model/harness events.
// ─────────────────────────────────────────────────────────────────────────────

export type NarrativeProgressListener = (event: NarrativeProgressEvent) => void;

export class NarrativeProgressFeed {
  private readonly subscribers = new Map<string, Set<NarrativeProgressListener>>();
  private readonly history = new Map<string, Map<string, NarrativeProgressEvent>>();
  private readonly pending = new Map<string, NarrativeProgressEvent>();

  /**
   * Commit a recipient-safe progress projection. A `starting` event begins a new
   * run for the review; later writes with the same key replace the pending
   * projection (R35 per-key conflation).
   */
  publish(event: NarrativeProgressEvent): void {
    if (event.phase === "starting") {
      this.history.set(event.reviewId, new Map());
      for (const key of this.pending.keys()) {
        if (key.startsWith(`${event.reviewId}\0`)) this.pending.delete(key);
      }
    }
    const history = this.history.get(event.reviewId) ?? new Map<string, NarrativeProgressEvent>();
    history.set(event.key, event);
    this.history.set(event.reviewId, history);
    this.pending.set(`${event.reviewId}\0${event.key}`, event);
  }

  /**
   * Deliver pending projections in pipeline order. The desktop composition root
   * flushes after each committed phase so the reader sees live work; batching
   * remains safe because repeated keys collapse to their latest honest state.
   */
  flush(): void {
    const pending = [...this.pending.values()].sort((left, right) => left.seq - right.seq);
    this.pending.clear();
    for (const event of pending) {
      const listeners = this.subscribers.get(event.reviewId);
      if (!listeners) continue;
      for (const listener of listeners) listener(event);
    }
  }

  /** A resumable progress summary, ordered as the pipeline produced it. */
  snapshot(reviewId: string): NarrativeProgressEvent[] {
    return [...(this.history.get(reviewId)?.values() ?? [])].sort(
      (left, right) => left.seq - right.seq,
    );
  }

  /**
   * Subscribe for a review and receive the current summary before future updates.
   * The returned closure is the sole ownership/disposal boundary.
   */
  subscribe(reviewId: string, listener: NarrativeProgressListener): () => void {
    for (const event of this.snapshot(reviewId)) listener(event);
    const listeners = this.subscribers.get(reviewId) ?? new Set<NarrativeProgressListener>();
    listeners.add(listener);
    this.subscribers.set(reviewId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(reviewId);
    };
  }
}
