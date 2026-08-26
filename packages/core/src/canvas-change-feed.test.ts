import type { CanvasChangeNotification } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { CanvasChangeFeed, isSeqGap } from "./canvas-change-feed";

const collect = (feed: CanvasChangeFeed, canvasId: string): CanvasChangeNotification[] => {
  const seen: CanvasChangeNotification[] = [];
  feed.subscribe(canvasId, (notification) => seen.push(notification));
  return seen;
};

// ── AC6a: conflation carries its covering range ──────────────────────────────

describe("per-key conflation carries the covering seq range (AC6)", () => {
  it("collapses several changes to one key into one notification spanning the range", () => {
    const feed = new CanvasChangeFeed();
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "el", seq: 5 });
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "el", seq: 6 });
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "el", seq: 7 });
    feed.flush();
    expect(seen).toEqual([
      { reviewId: "r", canvasId: "cv", elementKey: "el", seqRange: { from: 5, to: 7 } },
    ]);
  });

  it("keeps distinct element keys as distinct notifications, in seq order", () => {
    const feed = new CanvasChangeFeed();
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "second", seq: 9 });
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "first", seq: 4 });
    feed.flush();
    expect(seen.map((n) => n.elementKey)).toEqual(["first", "second"]);
  });
});

// ── AC6b: the payload is a notification, never a raw event ────────────────────

describe("the feed never publishes a raw event or a private row (AC6)", () => {
  it("delivers exactly the notification shape — no event body", () => {
    const feed = new CanvasChangeFeed();
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "el", seq: 1 });
    feed.flush();
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "canvasId",
      "elementKey",
      "reviewId",
      "seqRange",
    ]);
  });

  it("never publishes a private row", () => {
    const feed = new CanvasChangeFeed();
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "el", seq: 2, private: true });
    feed.flush();
    expect(seen).toEqual([]);
  });
});

// ── AC6c: missed-notification recovery via the gap rule ──────────────────────

describe("a consumer that misses notifications re-queries the projection (AC6)", () => {
  it("detects a seq gap after an overflow eviction and signals re-query", () => {
    // A buffer of one key: publishing a second, third key evicts the older
    // pending changes; only the newest survives to be delivered.
    const feed = new CanvasChangeFeed({ maxBufferedKeys: 1 });
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "a", seq: 1 }); // evicted
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "b", seq: 2 }); // evicted
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "c", seq: 3 }); // survives
    feed.flush();
    expect(seen).toHaveLength(1);

    // The consumer last applied seq 0. The delivered notification's range starts
    // at 3, past 0+1, so the gap rule fires and the consumer must re-query.
    const lastSeen = 0;
    expect(isSeqGap(lastSeen, seen[0] as CanvasChangeNotification)).toBe(true);
  });

  it("drives recovery: a consumer that observes a gap re-queries the projection store", () => {
    // The feed is an invalidation HINT — truth stays the store. This proves the
    // gap rule actually DRIVES a re-query, not merely that a predicate returns
    // true: a consumer wired to the feed reloads the projection on a gap. If the
    // gap never fired, `reloads` would stay 0 and this test would go red.
    const feed = new CanvasChangeFeed({ maxBufferedKeys: 1 });
    let lastSeen = 0;
    let reloads = 0;
    feed.subscribe("cv", (notification) => {
      if (isSeqGap(lastSeen, notification)) reloads += 1; // re-query the store
      lastSeen = notification.seqRange.to;
    });
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "a", seq: 1 }); // evicted
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "b", seq: 2 }); // evicted
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "c", seq: 3 }); // survives
    feed.flush();
    expect(reloads).toBe(1);
    expect(lastSeen).toBe(3);
  });

  it("does not signal a gap when the consumer is caught up", () => {
    const feed = new CanvasChangeFeed();
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "a", seq: 1 });
    feed.flush();
    expect(isSeqGap(0, seen[0] as CanvasChangeNotification)).toBe(false);
  });

  it("a late subscriber that missed early notifications trips the gap rule", () => {
    const feed = new CanvasChangeFeed();
    // Nobody is subscribed yet; these are delivered to no one.
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "a", seq: 1 });
    feed.flush();
    // A consumer subscribes now and only sees the later change.
    const seen = collect(feed, "cv");
    feed.publish({ reviewId: "r", canvasId: "cv", elementKey: "b", seq: 2 });
    feed.flush();
    expect(isSeqGap(0, seen[0] as CanvasChangeNotification)).toBe(true);
  });
});
