// ─────────────────────────────────────────────────────────────────────────────
// The session turn loop (#466 res. 3, B09 cluster 2 — Rennet owns the turn loop).
//
// Interactive turns run fresh-process-per-turn + `resume`: the harness CLI owns
// the transcript, compaction, and prompt cache; Rennet persists only the
// `HarnessCursor` pointer and re-passes it each turn. This loop owns the three
// things that are Rennet's, not the harness's:
//
//   1. SERIALIZE turns per session (one harness conversation, one turn in flight).
//      A second turn for the same session queues behind the first — a fresh
//      process resuming the same transcript must not race another. The lock is
//      per-session, never a global one.
//   2. RE-PASS options every turn. Each turn spawns a FRESH process, so nothing is
//      sticky: `buildSpec` is called afresh every turn to supply model/tools/cwd/
//      systemPrompt, and the resume pointer is merged from the just-loaded cursor.
//   3. PERSIST the advanced cursor after each completed turn, so the next turn
//      resumes exactly where this one left off (and a restart reattaches).
//
// The resume-vanished fallback (a persisted cursor whose harness transcript the
// CLI no longer has) is cluster 2's task 2.3, layered on top of this loop.
// ─────────────────────────────────────────────────────────────────────────────

import {
  advanceCursor,
  type HarnessError,
  type HarnessPort,
  type HarnessSession,
  planResume,
  type SessionOutcome,
  type SessionSpec,
} from "@rennet/core";
import type { SessionModel } from "@rennet/protocol";

/** The session persistence the loop reads the cursor from and writes it back to.
 *  The file-backed `SessionStore` (adapters) satisfies this; tests pass a fake. */
export interface SessionCursorStore {
  load(sessionId: string): SessionModel | undefined;
  save(session: SessionModel): void;
}

export interface TurnLoopDeps {
  readonly port: HarnessPort;
  readonly store: SessionCursorStore;
  /**
   * Build the turn's `SessionSpec` fresh EACH turn (cwd/model/tools/systemPrompt)
   * — never assumed sticky across a fresh process. The loop merges the resume
   * pointer from the loaded cursor, so `buildSpec` returns everything BUT resume.
   */
  readonly buildSpec: (session: SessionModel) => Omit<SessionSpec, "resume">;
}

export interface TurnResult {
  /** The session after the turn — cursor-advanced and persisted on a completed
   *  turn that reported a resume point; unchanged otherwise. */
  readonly session: SessionModel;
  readonly outcome: SessionOutcome;
}

const STREAM_ENDED_WITHOUT_TERMINAL: HarnessError = {
  class: "protocol",
  origin: "adapter",
  message: "the harness stream ended without a terminal frame",
  retryable: false,
  retryableSource: "inferred",
  nativeCode: null,
};

/** Drive one turn to its terminal outcome, always closing the session. The
 *  adapter emits `session.ended` for every terminal (completed OR failed); a
 *  stream that ends without one is surfaced as a failed outcome, never a hang. */
async function runTurnToOutcome(session: HarnessSession, prompt: string): Promise<SessionOutcome> {
  try {
    await session.send({ prompt });
    for await (const event of session.events) {
      if (event.kind === "session.ended") return event.outcome;
    }
    return { status: "failed", error: STREAM_ENDED_WITHOUT_TERMINAL };
  } finally {
    await session.close();
  }
}

/**
 * The turn loop: `runTurn(sessionId, prompt)` serialized per session. Each call
 * reloads the session (so a queued turn sees the cursor the prior turn persisted),
 * re-passes options, resumes from the cursor, and persists the advanced cursor.
 */
export class SessionTurnLoop {
  /** Per-session promise tails. The stored tail swallows rejection so one failed
   *  turn never wedges the queue; the returned promise carries the real result. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: TurnLoopDeps) {}

  runTurn(sessionId: string, prompt: string): Promise<TurnResult> {
    const prior = this.#tails.get(sessionId) ?? Promise.resolve();
    const run = prior.then(() => this.#runOnce(sessionId, prompt));
    this.#tails.set(
      sessionId,
      run.catch(() => {}),
    );
    return run;
  }

  async #runOnce(sessionId: string, prompt: string): Promise<TurnResult> {
    const current = this.deps.store.load(sessionId);
    if (current === undefined) {
      throw new Error(`SessionTurnLoop: session ${sessionId} is not persisted; mint it first`);
    }
    const resume = planResume(current);
    const spec: SessionSpec = {
      ...this.deps.buildSpec(current),
      ...(resume === undefined ? {} : { resume }),
    };
    const harnessSession = await this.deps.port.createSession(spec);
    const outcome = await runTurnToOutcome(harnessSession, prompt);
    if (outcome.status !== "completed") return { session: current, outcome };
    const advanced = advanceCursor(current, outcome);
    if (advanced !== current) this.deps.store.save(advanced);
    return { session: advanced, outcome };
  }
}
