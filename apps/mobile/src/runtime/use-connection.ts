// Shared review-detail runtime hooks (issue #383 M1). `useConnection` resolves the daemon a
// route is scoped to; `useReviewFocus` reports focus on the open review (so the daemon
// suppresses this device's push for it) and acknowledges its attention on landing (clear-on-
// view, propagated to every client). These are the load-bearing behaviours the detail screens
// share; the exact per-screen rendering sits on top.

import type { AttentionFamily } from "@rennet/protocol";
import { useEffect, useState } from "react";
import { newCommandId } from "../lib/ids";
import { asProjectedReview, type ProjectedReviewLike } from "../lib/projection";
import { useRuntime } from "./context";
import type { DaemonConnection } from "./daemon-registry";

/** The connection for a route's daemon id, or undefined if it is not paired (revoked). */
export function useConnection(daemonId: string): DaemonConnection | undefined {
  return useRuntime().registry.get(daemonId);
}

/** The state of loading a specific review by its own id (deep-link metadata, #383 batch). */
export interface LoadedReview {
  readonly status: "loading" | "ready" | "error" | "unreachable";
  readonly review?: ProjectedReviewLike;
  readonly repositoryPresent?: boolean;
  readonly error?: string;
}

/**
 * Load THIS review's own metadata by id (#383 batch, finding 13). A deep-linked review is not
 * necessarily the daemon's current bootstrap review, so every detail surface must `review.load`
 * the route's id to get its repository key + patchsets — never borrow the bootstrap review's.
 * Surfaces failure honestly (`error`) rather than spinning forever, and `unreachable` when the
 * daemon is not paired.
 */
export function useReviewLoad(daemonId: string, reviewId: string): LoadedReview {
  const connection = useConnection(daemonId);
  const [state, setState] = useState<LoadedReview>({ status: "loading" });
  useEffect(() => {
    if (!connection) {
      setState({ status: "unreachable" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    connection.supervisor
      .invoke("review.load", { commandId: newCommandId(), reviewId })
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "ready",
          review: asProjectedReview(result.review),
          repositoryPresent: result.repositoryPresent,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: error instanceof Error ? error.message : "This review could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId]);
  return state;
}

/**
 * On landing on a review surface: report focus on it (push suppression) and acknowledge the EXACT
 * attention this surface is the landing for (#382 M2 finding 10) — e.g. the turn screen clears
 * `ask-pending`, the digest clears `review-finished`. Clearing the WHOLE review's families on any
 * view was over-broad: viewing the digest should not silence a live ask. A surface that is not a
 * taxonomy landing (the raw canvas, a finding) passes no `family` and clears nothing — presence
 * only. Presence resets to unfocused when the screen unmounts.
 */
export function useReviewFocus(daemonId: string, reviewId: string, family?: AttentionFamily): void {
  const runtime = useRuntime();
  useEffect(() => {
    runtime.registry.reportPresence(
      { focused: true, visible: true, focusedReviewId: reviewId },
      daemonId,
    );
    if (family !== undefined) {
      const connection = runtime.registry.get(daemonId);
      void connection?.supervisor
        // The taxonomy id is `${family}:${reviewId}` (the daemon's derived attention id).
        .invoke("attention.acknowledge", { attentionId: `${family}:${reviewId}` })
        .catch(() => undefined);
    }
    return () => {
      runtime.registry.reportPresence(
        { focused: true, visible: true, focusedReviewId: undefined },
        daemonId,
      );
    };
  }, [runtime, daemonId, reviewId, family]);
}

/** A fresh command id for a review-scoped invocation. */
export { newCommandId };
