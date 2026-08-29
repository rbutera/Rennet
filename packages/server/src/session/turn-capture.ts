// ─────────────────────────────────────────────────────────────────────────────
// The three seams the composition root needs to run a coding turn THROUGH the
// session turn loop (B09 cluster 2's loop, instantiated in `create-server.ts`).
//
//   1. `createTranscriptCapture` — the loop's `recordTranscript` sink. Projects the
//      turn's harness events onto display transcript rows and appends them to the
//      durable store `session.transcript` reads, VERBATIM: the rows are stored as the
//      harness produced them, host paths and all. R19 is a TRANSPORT rule ("do not send
//      a host path to a remote client"), and the wire already enforces it — the listener
//      scrubs a projected connection's frames and leaves a loopback connection's alone.
//      Applying it here as well destroyed the reviewer's own paths at rest and bought
//      nothing. Failure-isolated: the transcript is a DISPLAY read-model, so an
//      unwritable or corrupt log never fails the coding turn that produced it.
//
//   2. `createContextRebuiltEmit` — the loop's `emit` sink, for the one transcript row
//      the projector CANNOT produce: `context_rebuilt` is synthesized by the loop when a
//      resume vanishes, not carried on the event stream.
//
//   3. `turnLoopRunPort` — the loop as a `HandoffRunPort`, so the issue-#18
//      checkpoint bracket keeps its exact shape (pre-checkpoint → turn →
//      post-checkpoint → diff) while the turn ITSELF is resumed from the persisted
//      `HarnessCursor` and captured. (Serialization is the ROUNDS RUNTIME's on this
//      path — it already enqueues each dispatch, bracket included, per session id.)
//
// All three live here rather than inline in the composition root so they are testable
// standalone (the `session-entry` / `pipeline-guard` precedent).
// ─────────────────────────────────────────────────────────────────────────────

import { type HandoffRunPort, harnessEventsToRows } from "@rennet/core";
import type { SessionTranscriptRow } from "@rennet/protocol";
import type { SessionTurnLoop, TurnLoopDeps } from "./turn-loop";

/** The durable transcript log's append side (`TranscriptStore` in adapters satisfies it). */
export interface TranscriptSink {
  append(sessionId: string, rows: readonly SessionTranscriptRow[]): void;
}

/**
 * Build the turn loop's `recordTranscript` sink over a durable transcript store.
 *
 * The rows are stored RAW — the reviewer's own repo root, home dir and any other absolute path
 * the harness printed survive to disk, because this is the reviewer's own machine reading back
 * their own coding turns and a path they cannot see is a worse transcript, not a safer one.
 * R19 is a rule about what crosses the WIRE to a remote client, and `projectCommandOutput`
 * applies it there (see `../projection`), on a projected connection only. Scrubbing again at
 * write time was lossy and bought nothing, since every read already passes that boundary.
 *
 * `onError` receives a refused append (the store refuses rather than clobbering unread history)
 * instead of it being raised into the coding turn.
 */
export function createTranscriptCapture(
  store: TranscriptSink,
  onError: (error: unknown) => void = () => undefined,
): NonNullable<TurnLoopDeps["recordTranscript"]> {
  return ({ sessionId, events }) => {
    try {
      store.append(sessionId, harnessEventsToRows(events));
    } catch (error) {
      onError(error);
    }
  };
}

/**
 * Build the turn loop's `emit` sink, so the loop's synthesized `context_rebuilt` marker reaches
 * the reader's transcript.
 *
 * This row is reachable only because resume is live: when the CLI no longer has the conversation
 * the persisted cursor points at, the loop rebuilds context on a fresh session. That is a real
 * discontinuity, and it is NOT a harness event — the projector cannot produce it from the stream.
 * Dropped, the transcript would read CONTINUOUS across a context loss, which is the surface
 * claiming something it cannot know.
 *
 * `compact_boundary` is deliberately NOT handled here: those ARE harness events, so
 * `harnessEventsToRows` already projects them out of the captured stream. Appending them again
 * would double every compaction.
 */
export function createContextRebuiltEmit(
  store: TranscriptSink,
  onError: (error: unknown) => void = () => undefined,
): NonNullable<TurnLoopDeps["emit"]> {
  return (sessionId, row) => {
    if (row.kind !== "context_rebuilt") return;
    try {
      store.append(sessionId, [
        { kind: "context-rebuilt", id: `rebuilt-${sessionId}-${Date.now()}`, reason: row.reason },
      ]);
    } catch (error) {
      onError(error);
    }
  };
}

/**
 * The turn loop as a `HandoffRunPort`. The cwd comes from the session record (the loop's
 * `buildSpec`), which is the same repo root the checkpoint bracket is taken over, so the
 * port's own `input.cwd` is redundant here. A failed or cancelled turn is reported honestly —
 * never a fabricated success.
 */
export function turnLoopRunPort(
  loop: Pick<SessionTurnLoop, "runTurn">,
  sessionId: string,
): HandoffRunPort {
  return async (input) => {
    const { outcome } = await loop.runTurn(sessionId, input.prompt);
    if (outcome.status === "completed") {
      return {
        status: "completed",
        finalText: outcome.finalText,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      };
    }
    return {
      status: "failed",
      reason:
        outcome.status === "cancelled" ? "the handoff turn was cancelled" : outcome.error.message,
    };
  };
}
