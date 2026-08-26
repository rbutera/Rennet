import type { CanvasChangeNotification } from "@rennet/protocol";
import { useMemo, useSyncExternalStore } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// The R35 renderer subscription contract (issue #11).
//
// Live updates arrive as change-feed NOTIFICATIONS — invalidation hints, never
// raw events. The store stays truth: a consumer that misses a notification
// re-queries the projection (the gap rule lives engine-side in #10's feed). No
// RxJS: the push binds through React's `useSyncExternalStore`, ephemeral view
// state stays in `zustand` (store.ts), and every subscription has a stated owner
// and disposal point (unmount / review close) with a leak test.
//
// The UI depends only on the `CanvasFeedSource` SHAPE; the concrete feed
// (`@rennet/core`'s `CanvasChangeFeed`) is injected from the app layer, keeping
// `layer:ui` clean (types + protocol only).
// ─────────────────────────────────────────────────────────────────────────────

export type CanvasChangeListener = (notification: CanvasChangeNotification) => void;

/** The injected feed the renderer subscribes to (shape of core's `CanvasChangeFeed`). */
export interface CanvasFeedSource {
  subscribe(canvasId: string, listener: CanvasChangeListener): () => void;
}

/** The external store the hook binds through `useSyncExternalStore`. */
export interface CanvasFeedStore {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): CanvasChangeNotification | null;
}

/**
 * Build the external store for one canvas. `subscribe` wires the feed source and
 * returns its teardown — the stated disposal point. `getSnapshot` returns the
 * latest notification (a stable `null` until one arrives), so a mounted consumer
 * re-renders exactly when a new notification lands and can re-query.
 */
export function createCanvasFeedStore(source: CanvasFeedSource, canvasId: string): CanvasFeedStore {
  let latest: CanvasChangeNotification | null = null;
  return {
    subscribe(onStoreChange) {
      // The subscription's owner is this store; its disposal point is the
      // returned teardown, which removes the listener from the source (leak test).
      return source.subscribe(canvasId, (notification) => {
        latest = notification;
        onStoreChange();
      });
    },
    getSnapshot() {
      return latest;
    },
  };
}

/**
 * Bind a canvas's change feed for the lifetime of the calling component. React
 * calls the store's teardown on unmount or when `(source, canvasId)` changes, so
 * the subscription is disposed with the component that owns it. Returns the latest
 * notification (the invalidation hint) for the consumer to re-query on.
 */
export function useCanvasFeed(
  source: CanvasFeedSource,
  canvasId: string,
): CanvasChangeNotification | null {
  const store = useMemo(() => createCanvasFeedStore(source, canvasId), [source, canvasId]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
