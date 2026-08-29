import type { CommandInput } from "@rennet/protocol";
import { useEffect, useRef } from "react";
import { useCommand, useInvoke, useRefreshCommand } from "../data";
import { type AskWriteCommand, useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// useAskLog — the client half of the durable-asks contract (B11 cluster 2 said it in as
// many words: "the contract the client honours when it calls `ask.*`"). It did not.
//
// Eleven `ask.*` handlers, the projection, the fold and the file-backed log were all built
// and tested, and NOTHING in the client called any of them but `ask.setVerdictOverride`.
// The reviewer's asks lived in the `review` store slice and nowhere else, so every server
// path that reads `askLog.readProjection(reviewId)` read an EMPTY log:
//
//   • `publish.compose(mode:"review")` composed nothing, and `publish.review` refused with
//     "Publish refused: the review has no content" — the team-reviewer Post exit could
//     never succeed.
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
// Hydration waits for QUIET. Every write invalidates the `ask.` family, so a read is in
// flight for most of a burst of typing, and an answer composed BEFORE the newest write
// would momentarily un-stage what the reviewer just staged. Hydrating only while no write
// is outstanding removes that window entirely: the last write's own invalidation lands
// after the counter falls to zero, so the settled projection always gets applied.
//
// Not wired here: the R19 `broadcastAskProjection` push. The daemon fans it out
// (`server/src/ws-listener.ts`), but no bridge method carries it to a client — there is no
// `onAskProjection` on `RennetBridge`, in the WS bridge, or in the supervisor's resubscribe
// registry. That is second-device liveness, not this loop; a reconnecting client rehydrates
// through `ask.read`, which is what the contract says it is for.
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
  // How many durable writes are outstanding. Hydration is held while this is above zero.
  const writing = useRef(0);

  const read = useCommand("ask.read", { sessionId: reviewId });
  const projection = read.data?.projection;

  useEffect(() => {
    writing.current = 0;
    setAskWriter(
      <K extends AskWriteCommand>(name: K, input: Omit<CommandInput<K>, "sessionId">) => {
        writing.current += 1;
        // The session id IS the review id (the ask-log contract). Spreading a generic input
        // widens the type, so the cast restates what the Omit above already established.
        void invoke(name, { ...input, sessionId: reviewId } as CommandInput<K>)
          .then(refreshCompose, held)
          .finally(() => {
            writing.current -= 1;
          });
      },
    );
    return () => setAskWriter(null);
  }, [invoke, refreshCompose, reviewId, setAskWriter]);

  useEffect(() => {
    if (projection === undefined || writing.current > 0) return;
    hydrateAsks(projection);
  }, [projection, hydrateAsks]);
}
