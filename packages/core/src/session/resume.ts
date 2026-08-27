import type { HarnessCursor, SessionModel } from "@rennet/protocol";
import type { SessionOutcome } from "../harness";

/**
 * `core/session/resume.ts` — the pure cursor-resume decisions (#466 res. 3, B09
 * cluster 2). Interactive turns run fresh-process-per-turn + `resume`: the CLI
 * owns the transcript, Rennet persists only the `HarnessCursor` pointer and
 * re-passes it each turn. These are the pure pieces the server turn loop wires;
 * no I/O, no model, no Node.
 */

/**
 * The resume pointer to hand a fresh turn, derived from the session's persisted
 * cursor. Absent when the session has no cursor yet — a first turn starts a fresh
 * harness conversation (`SessionSpec.resume` left unset), never a resume of
 * nothing.
 */
export function planResume(session: SessionModel): { harnessSessionId: string } | undefined {
  return session.harnessCursor === undefined
    ? undefined
    : { harnessSessionId: session.harnessCursor.harnessSessionId };
}

/**
 * Advance the session's `HarnessCursor` after a completed turn, from what the
 * harness reported on its terminal frame. `turnCount` increments from the prior
 * cursor (0 when there was none). The cursor advances ONLY when the harness gave
 * a COMPLETE resume point (both the session id and the tail message anchor the
 * frozen `HarnessCursorSchema` requires) — otherwise the session is returned
 * unchanged, an honest "no durable resume point" rather than a cursor with a
 * fabricated anchor. An adapter that does not implement resume never reports
 * these, so its turns never build a durable cursor (they run fresh each time).
 */
export function advanceCursor(
  session: SessionModel,
  reported: { harnessSessionId?: string; lastAssistantMessageAnchor?: string },
): SessionModel {
  if (
    reported.harnessSessionId === undefined ||
    reported.lastAssistantMessageAnchor === undefined
  ) {
    return session;
  }
  const cursor: HarnessCursor = {
    harnessSessionId: reported.harnessSessionId,
    lastAssistantMessageAnchor: reported.lastAssistantMessageAnchor,
    turnCount: (session.harnessCursor?.turnCount ?? 0) + 1,
  };
  return { ...session, harnessCursor: cursor };
}

/**
 * Drop the session's harness cursor (B09 task 2.3, the resume-vanished path).
 * When the harness no longer has the transcript the cursor named, the pointer is
 * stale: clearing it lets the next turn start a FRESH harness conversation and
 * re-mint the cursor from `turnCount` 1. The session's boards, threads, claim,
 * and review are untouched — only the harness pointer is dropped.
 */
export function dropCursor(session: SessionModel): SessionModel {
  return { ...session, harnessCursor: undefined };
}

/**
 * Decide whether a turn that RESUMED a prior harness conversation failed because
 * that conversation is gone (the CLI no longer has the transcript the cursor
 * named), so the loop should rebuild context honestly rather than surface a dead
 * turn (B09 task 2.3, #466 res. 3).
 *
 * The signal is the harness's terminal `error_during_execution` subtype, preserved
 * verbatim as the outcome error's `nativeCode` (the SDK refuses a resume of a
 * missing transcript with exactly this result — sdk.d.ts). Keying on the native
 * SUBTYPE, not the broad `invalid-request` class, is what makes this narrow (B09
 * F4): `model_not_found` also maps to `invalid-request` but carries a DIFFERENT
 * native code, so a bad-model turn is no longer mistaken for a vanished transcript.
 * Transient failures (rate-limit, overloaded, upstream) and auth failures are
 * different classes and codes — NOT treated as vanished — because they would fail
 * a fresh turn too, so they surface as real failures instead of a wasteful rebuild.
 *
 * Residual breadth (recorded in the ledger, F4): a resumed turn that errors mid-
 * execution for a NON-resume reason also carries this subtype and would rebuild
 * fresh — non-destructive (boards stay canonical), the honest degrade. The precise
 * missing-session message match is confirmed against the live CLI in the packet
 * E2E (cluster 8); this pure rule is what the offline gate exercises through the
 * real adapter frame mapping (`normalizeClaudeFrame`), not a synthetic error class.
 */
export function isResumeVanished(attemptedResume: boolean, outcome: SessionOutcome): boolean {
  return (
    attemptedResume &&
    outcome.status === "failed" &&
    outcome.error.nativeCode === "error_during_execution"
  );
}
