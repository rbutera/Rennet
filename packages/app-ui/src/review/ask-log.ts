import type { AskProjection, CommandInput } from "@rennet/protocol";
import { useEffect, useRef } from "react";
import { useCommand, useCommandStream, useInvoke, useRefreshCommand } from "../data";
import { type AskWriteCommand, useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// useAskLog — the client half of the durable-asks contract (B11 cluster 2 said it in as
// many words: "the contract the client honours when it calls `ask.*`"). It did not.
//
// Thirteen `ask.*` handlers, the projection, the fold and the file-backed log were all built
// and tested, and NOTHING in the client called any of them but `ask.setVerdictOverride`.
// The reviewer's asks lived in the `review` store slice and nowhere else, so every server
// path that reads `askLog.readProjection(reviewId)` read an EMPTY log:
//
//   • `publish.compose(mode:"review")` saw no staged line comments, so the Post exit silently
//     lost the reviewer's requested changes and could only compose a zero-ask approval.
//   • `round.dispatch` folded an empty projection into an empty work order.
//   • `review.reviseSpan` answered "That ask is no longer staged." for every ask.
//   • A reload lost everything the reviewer had staged.
//
// The verdict override being the ONE wired command is why it survived review: a compose
// carrying a correct verdict and no comments reads like a review with nothing to say.
//
// This hook closes the loop for the open review, in the direction the server always
// intended — the log is the source of truth:
//
//   READ   `ask.read` answers the projection; `hydrateAsks` replaces the slice's durable
//          half with it. That is the reload promise, and it is also the reconcile: a write
//          the server REFUSED (an unsafe comment path, say) is undone by the next answer
//          rather than lingering as a local ghost that composes to nothing.
//   WRITE  the slice's write sink invokes the matching `ask.*` command with this review's
//          id as the session id. Bound once, here — no surface passes a session id, so no
//          surface can write an ask into another review's log.
//
// Hydration waits for QUIET. A successful write invalidates the `ask.` family, so a read
// can be in flight through most of a burst of typing, and an answer composed BEFORE the
// newest write would momentarily un-stage what the reviewer just staged. Hydrating only
// while no write is outstanding removes that window entirely. Every settlement decrements
// first and then explicitly invalidates `ask.read`, including rejection: the final
// post-decrement read applies the daemon's settled projection and removes any refused ghost.
//
// The daemon's full-projection push folds into the same `ask.read` cache. That includes
// server-authored cleanup after a completed round, so the open renderer drops consumed asks
// without waiting for a reload. A reconnect still rehydrates through `ask.read`.
// ─────────────────────────────────────────────────────────────────────────────

/** Fire-and-forget: the write already landed or honestly failed; this only settles it. */
const held = () => undefined;

/**
 * Bind the open review's durable ask log to the `review` store slice: hydrate from
 * `ask.read`, and write every mutation through `ask.*` under `reviewId`.
 */
export function useAskLog(reviewId: string): void {
  const invoke = useInvoke();
  const setAskWriter = useRennetStore((s) => s.reviewActions.setAskWriter);
  const hydrateAsks = useRennetStore((s) => s.reviewActions.hydrateAsks);
  // A staged ask changes what the exits compose, so it stales the composed preview the
  // hand-off lane renders — the same invalidation `ask.setVerdictOverride` already declares.
  const refreshCompose = useRefreshCommand("publish.compose");
  const refreshAsks = useRefreshCommand("ask.read");
  // One counter object per binding. A late settlement from the previous review decrements
  // its own retired object, never the current review's count.
  const writing = useRef<{ count: number; deferred?: AskProjection }>({ count: 0 });

  const read = useCommand("ask.read", { sessionId: reviewId });
  useCommandStream({
    channel: "askProjection",
    delivery: "snapshot",
    subscriptionKey: reviewId,
    command: { name: "ask.read", input: { sessionId: reviewId } },
    fold: (_previous, next) => {
      if (writing.current.count > 0) writing.current.deferred = next;
      // A projection push may come from another client or from server-authored round cleanup.
      // The composed signing preview is frozen against the prior projection, so invalidate it
      // when the new authority reaches this renderer. Otherwise a held-open preview stays stale
      // and every post retry fails until the route is reopened.
      refreshCompose();
      return { projection: next };
    },
  });
  const projection = read.data?.projection;

  useEffect(() => {
    const current: { count: number; deferred?: AskProjection } = { count: 0 };
    writing.current = current;
    setAskWriter(
      <K extends AskWriteCommand>(name: K, input: Omit<CommandInput<K>, "sessionId">) => {
        current.count += 1;
        // The session id IS the review id (the ask-log contract). Spreading a generic input
        // widens the type, so the cast restates what the Omit above already established.
        void invoke(name, { ...input, sessionId: reviewId } as CommandInput<K>)
          .then(refreshCompose, held)
          .finally(() => {
            current.count -= 1;
            if (
              current.count === 0 &&
              writing.current === current &&
              current.deferred !== undefined
            ) {
              const deferred = current.deferred;
              delete current.deferred;
              hydrateAsks(deferred);
            }
            refreshAsks();
          });
      },
    );
    return () => setAskWriter(null);
  }, [hydrateAsks, invoke, refreshAsks, refreshCompose, reviewId, setAskWriter]);

  useEffect(() => {
    if (projection === undefined || writing.current.count > 0) return;
    hydrateAsks(projection);
  }, [projection, hydrateAsks]);
}
