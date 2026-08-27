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
// RESUME-VANISHED FALLBACK (task 2.3): when a resumed turn fails because the CLI
// no longer has that conversation's transcript, the loop rebuilds context
// honestly — it emits a `context_rebuilt` row, drops the stale cursor, and re-runs
// the turn FRESH (no resume). The boards stay canonical: this loop never writes a
// board, so a rebuild cannot drop or re-draft one; the reconstructed session
// re-reads boards from the event log elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

import {
  advanceCursor,
  dropCursor,
  type HarnessError,
  type HarnessPort,
  type HarnessSession,
  isResumeVanished,
  planResume,
  type SessionOutcome,
  type SessionSpec,
} from "@rennet/core";
import type { SessionModel } from "@rennet/protocol";

/**
 * A row on the turn stream the reader sees. `context_rebuilt` is the honest
 * marker that a resumed conversation's transcript was gone and context was
 * rebuilt (B09 task 2.3) — a fact surfaced, never a gate. Cluster 3 extends this
 * union with the harness's own `compact_boundary`.
 */
export type TurnRow = { readonly kind: "context_rebuilt"; readonly reason: string };

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
  /** Sink for turn-stream rows (e.g. the `context_rebuilt` marker). Optional. */
  readonly emit?: (row: TurnRow) => void;
}

export interface TurnResult {
  /** The session after the turn — cursor-advanced and persisted on a completed
   *  turn that reported a resume point; unchanged otherwise. */
  readonly session: SessionModel;
  readonly outcome: SessionOutcome;
  /** True when the resume-vanished fallback fired: the resumed transcript was
   *  gone, so context was rebuilt on a fresh session (task 2.3). */
  readonly contextRebuilt?: boolean;
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
      run.catch(() => undefined),
    );
    return run;
  }

  async #runOnce(sessionId: string, prompt: string): Promise<TurnResult> {
    const current = this.deps.store.load(sessionId);
    if (current === undefined) {
      throw new Error(`SessionTurnLoop: session ${sessionId} is not persisted; mint it first`);
    }
    const resume = planResume(current);
    const outcome = await this.#runTurn(current, prompt, resume);

    // Resume-vanished fallback: the harness lost this conversation's transcript.
    // Rebuild context honestly — one fresh turn, no resume — and tell the reader.
    if (resume !== undefined && isResumeVanished(true, outcome)) {
      this.deps.emit?.({
        kind: "context_rebuilt",
        reason: "the harness no longer has this conversation's transcript",
      });
      // Drop the stale cursor so the fresh conversation re-mints it from turn 1.
      // Boards/threads/claim are untouched — only the harness pointer is cleared.
      const rebuilt = dropCursor(current);
      const freshOutcome = await this.#runTurn(rebuilt, prompt, undefined);
      if (freshOutcome.status !== "completed") {
        return { session: rebuilt, outcome: freshOutcome, contextRebuilt: true };
      }
      const advanced = advanceCursor(rebuilt, freshOutcome);
      this.deps.store.save(advanced);
      return { session: advanced, outcome: freshOutcome, contextRebuilt: true };
    }

    if (outcome.status !== "completed") return { session: current, outcome };
    const advanced = advanceCursor(current, outcome);
    if (advanced !== current) this.deps.store.save(advanced);
    return { session: advanced, outcome };
  }

  /** One harness turn: re-pass options (fresh `buildSpec`) and merge the resume
   *  pointer, spawn a fresh session, and drive it to its terminal outcome. */
  #runTurn(
    session: SessionModel,
    prompt: string,
    resume: { harnessSessionId: string } | undefined,
  ): Promise<SessionOutcome> {
    const spec: SessionSpec = {
      ...this.deps.buildSpec(session),
      ...(resume === undefined ? {} : { resume }),
    };
    return this.deps.port
      .createSession(spec)
      .then((harnessSession) => runTurnToOutcome(harnessSession, prompt));
  }
}
