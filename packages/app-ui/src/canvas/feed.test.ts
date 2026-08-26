import type { CanvasChangeNotification } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type CanvasChangeListener, type CanvasFeedSource, createCanvasFeedStore } from "./feed";

/** A feed source that exposes its live listener set so a leak is observable. */
function mockSource(): CanvasFeedSource & { count(canvasId: string): number } {
  const listeners = new Map<string, Set<CanvasChangeListener>>();
  return {
    subscribe(canvasId, listener) {
      const set = listeners.get(canvasId) ?? new Set();
      set.add(listener);
      listeners.set(canvasId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(canvasId);
      };
    },
    count(canvasId) {
      return listeners.get(canvasId)?.size ?? 0;
    },
  };
}

describe("canvas feed subscription — stated owner, disposal point, no leak", () => {
  it("disposes the subscription on teardown, leaving no listener behind", () => {
    const source = mockSource();
    const store = createCanvasFeedStore(source, "cv-1");
    const teardown = store.subscribe(() => undefined);
    expect(source.count("cv-1")).toBe(1);
    teardown();
    expect(source.count("cv-1")).toBe(0);
  });

  it("delivers the latest notification as the snapshot for re-query", () => {
    const source = mockSource();
    const store = createCanvasFeedStore(source, "cv-1");
    let captured: CanvasChangeListener | undefined;
    const original = source.subscribe.bind(source);
    source.subscribe = (canvasId, listener) => {
      captured = listener;
      return original(canvasId, listener);
    };
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    expect(store.getSnapshot()).toBeNull();
    const notification: CanvasChangeNotification = {
      reviewId: "rv",
      canvasId: "cv-1",
      elementKey: "e1",
      seqRange: { from: 3, to: 5 },
    };
    captured?.(notification);
    expect(changes).toBe(1);
    expect(store.getSnapshot()).toEqual(notification);
  });
});
