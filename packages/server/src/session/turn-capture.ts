// ─────────────────────────────────────────────────────────────────────────────
// The two seams the composition root needs to run a coding turn THROUGH the
// session turn loop (B09 cluster 2's loop, instantiated in `create-server.ts`).
//
//   1. `createTranscriptCapture` — the loop's `recordTranscript` sink. Projects the
//      turn's harness events onto display transcript rows, R19-scrubs them at this
//      ONE choke point (before they are persisted), and appends them to the durable
//      store `session.transcript` reads. Failure-isolated: the transcript is a
//      DISPLAY read-model, so an unwritable or corrupt log never fails the coding
//      turn that produced it.
//
//   2. `turnLoopRunPort` — the loop as a `HandoffRunPort`, so the issue-#18
//      checkpoint bracket keeps its exact shape (pre-checkpoint → turn →
//      post-checkpoint → diff) while the turn ITSELF is serialized per session,
//      resumed from the persisted `HarnessCursor`, and captured.
//
// Both live here rather than inline in the composition root so they are testable
// standalone (the `session-entry` / `pipeline-guard` precedent).
// ─────────────────────────────────────────────────────────────────────────────

import { homedir } from "node:os";
import { type HandoffRunPort, harnessEventsToRows } from "@rennet/core";
import type { SessionTranscriptRow } from "@rennet/protocol";
import { buildProjectionContext, redactAbsolutePaths, scrubRoots } from "../projection";
import type { SessionTurnLoop, TurnLoopDeps } from "./turn-loop";

/** The durable transcript log's append side (`TranscriptStore` in adapters satisfies it). */
export interface TranscriptSink {
  append(sessionId: string, rows: readonly SessionTranscriptRow[]): void;
}

/**
 * Build the turn loop's `recordTranscript` sink over a durable transcript store.
 *
 * The R19 scrub runs HERE, once, before persistence: the turn's own repo root reads back as
 * `<repo>`, the home dir as `~`, and any absolute path outside both is redacted — so a host
 * path cannot reach the persisted rows, let alone a projected client. `onError` receives a
 * refused append (the store refuses rather than clobbering unread history) instead of it
 * being raised into the coding turn.
 */
export function createTranscriptCapture(
  store: TranscriptSink,
  onError: (error: unknown) => void = () => undefined,
  homeDir: string = homedir(),
): NonNullable<TurnLoopDeps["recordTranscript"]> {
  return ({ sessionId, cwd, events }) => {
    const ctx = buildProjectionContext([cwd], homeDir);
    const rows = harnessEventsToRows(events, (text) => redactAbsolutePaths(scrubRoots(text, ctx)));
    try {
      store.append(sessionId, rows);
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
