// Shared review-detail runtime hooks (issue #383 M1). `useConnection` resolves the daemon a
// route is scoped to; `useReviewFocus` reports focus on the open review (so the daemon
// suppresses this device's push for it) and acknowledges its attention on landing (clear-on-
// view, propagated to every client). These are the load-bearing behaviours the detail screens
// share; the exact per-screen rendering sits on top.

import { useEffect } from "react";
import { newCommandId } from "../lib/ids";
import { useRuntime } from "./context";
import type { DaemonConnection } from "./daemon-registry";

/** The connection for a route's daemon id, or undefined if it is not paired (revoked). */
export function useConnection(daemonId: string): DaemonConnection | undefined {
  return useRuntime().registry.get(daemonId);
}

/**
 * On landing on a review surface: report focus on it (push suppression) and acknowledge its
 * attention so the needs-you badge clears here and on every other client. Presence resets to
 * unfocused when the screen unmounts.
 */
export function useReviewFocus(daemonId: string, reviewId: string): void {
  const runtime = useRuntime();
  useEffect(() => {
    runtime.registry.reportPresence(
      { focused: true, visible: true, focusedReviewId: reviewId },
      daemonId,
    );
    const connection = runtime.registry.get(daemonId);
    void connection?.supervisor
      .invoke("attention.acknowledge", { reviewId })
      .catch(() => undefined);
    return () => {
      runtime.registry.reportPresence(
        { focused: true, visible: true, focusedReviewId: undefined },
        daemonId,
      );
    };
  }, [runtime, daemonId, reviewId]);
}

/** A fresh command id for a review-scoped invocation. */
export { newCommandId };
