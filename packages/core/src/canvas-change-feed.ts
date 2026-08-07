import type { CanvasChangeNotification } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Canvas-scoped post-commit change feed (issue #10; R35's ONE change feed, canvas
// half). A dependency-free typed emitter, keyed (reviewId, canvasId, elementKey),
// carrying a covering seq range. It is an INVALIDATION HINT — truth stays the
// store; a consumer that misses a notification re-queries the projection.
//
// Reactive discipline as contract language (R35): explicit subscription
// lifecycle, per-key conflation with the covered seq range, bounded buffers,
// store-commit ordering, recipient-specific projections (never a raw
// `EventEnvelope`), and a private row is never published. The emission point (the
// post-commit hook) is #31's; this defines the payload + subscription contract.
// ─────────────────────────────────────────────────────────────────────────────

/** A change to publish to the feed after a commit. Carries the committed `seq`. */
export interface CanvasChange {
  reviewId: string;
  canvasId: string;
  elementKey: string;
  seq: number;
  /** A private row is NEVER published — the feed drops it silently. */
  private?: boolean;
}

/** The per-key coalescer entry: the covering seq range for one element key. */
interface BufferedChange {
  reviewId: string;
  canvasId: string;
  elementKey: string;
  from: number;
  to: number;
}

/** A subscriber's notification listener. */
export type CanvasChangeListener = (notification: CanvasChangeNotification) => void;

export interface CanvasChangeFeedOptions {
  /** The maximum number of pending element keys buffered before eviction. */
  maxBufferedKeys?: number;
}

/**
 * The gap rule: a delivered notification whose `seqRange.from` exceeds the
 * consumer's last-seen seq PLUS ONE means the consumer missed a notification
 * (from overflow eviction or a late subscription) and MUST re-query the
 * projection from the store. This single rule covers both miss causes.
 */
export function isSeqGap(lastSeenSeq: number, notification: CanvasChangeNotification): boolean {
  return notification.seqRange.from > lastSeenSeq + 1;
}

export class CanvasChangeFeed {
  private readonly maxBufferedKeys: number;
  private readonly subscribers = new Map<string, Set<CanvasChangeListener>>();
  /** Insertion-ordered pending changes, keyed `reviewId\0canvasId\0elementKey`. */
  private readonly buffer = new Map<string, BufferedChange>();

  constructor(options: CanvasChangeFeedOptions = {}) {
    this.maxBufferedKeys = options.maxBufferedKeys ?? 1000;
  }

  /** Subscribe to a canvas's notifications. Returns an unsubscribe function. */
  subscribe(canvasId: string, listener: CanvasChangeListener): () => void {
    const set = this.subscribers.get(canvasId) ?? new Set<CanvasChangeListener>();
    set.add(listener);
    this.subscribers.set(canvasId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(canvasId);
    };
  }

  /**
   * Buffer a post-commit change, coalescing by `(canvasId, elementKey)` so a
   * later flush emits ONE notification per key with the covering seq range. A
   * private row is dropped and never published. When the buffer would exceed
   * `maxBufferedKeys` the OLDEST pending key is evicted — its loss is safe because
   * the next notification's `seqRange.from` will trip the gap rule and force a
   * re-query.
   */
  publish(change: CanvasChange): void {
    if (change.private) return;
    // Keyed by the full (reviewId, canvasId, elementKey) triple per R35. canvasId
    // already encodes reviewId today, but keying on the stated triple keeps the
    // conflation contract self-evident and robust to any future canvasId change.
    const key = `${change.reviewId}\0${change.canvasId}\0${change.elementKey}`;
    const existing = this.buffer.get(key);
    if (existing) {
      existing.from = Math.min(existing.from, change.seq);
      existing.to = Math.max(existing.to, change.seq);
      return;
    }
    if (this.buffer.size >= this.maxBufferedKeys) {
      const oldest = this.buffer.keys().next().value;
      if (oldest !== undefined) this.buffer.delete(oldest);
    }
    this.buffer.set(key, {
      reviewId: change.reviewId,
      canvasId: change.canvasId,
      elementKey: change.elementKey,
      from: change.seq,
      to: change.seq,
    });
  }

  /**
   * Deliver the buffered notifications to their canvas's subscribers, in
   * store-commit (seq) order, then clear the buffer. A conflated notification
   * carries the covering `seqRange`. The delivered payload is exactly a
   * `CanvasChangeNotification` — never a raw event, never a private row.
   */
  flush(): void {
    const pending = [...this.buffer.values()].sort((left, right) => left.from - right.from);
    this.buffer.clear();
    for (const change of pending) {
      const listeners = this.subscribers.get(change.canvasId);
      if (!listeners) continue;
      const notification: CanvasChangeNotification = {
        reviewId: change.reviewId,
        canvasId: change.canvasId,
        elementKey: change.elementKey,
        seqRange: { from: change.from, to: change.to },
      };
      for (const listener of listeners) listener(notification);
    }
  }

  /** The number of pending element keys currently buffered (for tests/inspection). */
  pendingKeyCount(): number {
    return this.buffer.size;
  }
}
