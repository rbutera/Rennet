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
  type HarnessEvent,
  type HarnessPort,
  type HarnessSession,
  isResumeVanished,
  planResume,
  type SessionOutcome,
  type SessionSpec,
} from "@rennet/core";
import type { SessionModel } from "@rennet/protocol";

/**
 * A row on the turn stream the reader sees. Two honest discontinuity markers,
 * kept distinct:
 *
 *   - `context_rebuilt` (task 2.3): the harness lost this conversation's
 *     transcript, so Rennet rebuilt context from the canonical boards — context
 *     was LOST and reconstructed.
 *   - `compact_boundary` (task 3.1): the harness SUMMARIZED its own context in
 *     place — nothing lost, the CLI compacted its transcript. `trigger` says
 *     auto vs. user-asked; `preTokens`/`postTokens` are the harness's OWN figures
 *     (ask-don't-estimate), carried only when it reported them.
 *
 * Both are facts surfaced, never gates.
 */
export type TurnRow =
  | { readonly kind: "context_rebuilt"; readonly reason: string }
  | {
      readonly kind: "compact_boundary";
      readonly trigger: "auto" | "manual";
      readonly preTokens?: number;
      readonly postTokens?: number;
    };

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
  /**
   * Capture a completed turn's raw harness events for the DISPLAY transcript (issue-set B).
   * The turn loop is the single serialized writer that already sees every event and persists
   * the cursor, so it is the natural capture point. The sink (wired in the composition root)
   * projects these events to transcript rows — R19-scrubbing at that choke point using `cwd` —
   * and appends them to the durable transcript store. Optional: absent ⇒ no transcript captured
   * (the session read stays honest-empty), the harness CLI remains canonical either way.
   */
  readonly recordTranscript?: (input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly events: readonly HarnessEvent[];
  }) => void;
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
 *  stream that ends without one is surfaced as a failed outcome, never a hang.
 *  Each harness `compact_boundary` seen mid-stream is surfaced to the reader as
 *  one `compact_boundary` row (task 3.1) — the harness's own figures, forwarded
 *  verbatim, never estimated. */
async function runTurnToOutcome(
  session: HarnessSession,
  prompt: string,
  onRow?: (row: TurnRow) => void,
  captureEvents?: (events: readonly HarnessEvent[]) => void,
): Promise<SessionOutcome> {
  // Collect every event for the display-transcript capture. `session.ended` returns early, so
  // the capture runs in `finally` — a completed OR failed turn still records what it ran.
  const collected: HarnessEvent[] = [];
  try {
    await session.send({ prompt });
    for await (const event of session.events) {
      collected.push(event);
      if (event.kind === "compact_boundary") {
        onRow?.({
          kind: "compact_boundary",
          trigger: event.trigger,
          ...(event.preTokens === undefined ? {} : { preTokens: event.preTokens }),
          ...(event.postTokens === undefined ? {} : { postTokens: event.postTokens }),
        });
        continue;
      }
      if (event.kind === "session.ended") return event.outcome;
    }
    return { status: "failed", error: STREAM_ENDED_WITHOUT_TERMINAL };
  } finally {
    await session.close();
    if (captureEvents && collected.length > 0) captureEvents(collected);
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
      // Drop the stale cursor and PERSIST it BEFORE retrying (F4): a retry that
      // fails must not leave the vanished pointer on disk to be resumed again next
      // turn. Reload the latest record first (F2) so a concurrent thread/archive
      // survives; only the harness pointer is cleared — boards/threads/claim stay.
      const rebuilt = dropCursor(this.deps.store.load(sessionId) ?? current);
      this.deps.store.save(rebuilt);
      const freshOutcome = await this.#runTurn(rebuilt, prompt, undefined);
      if (freshOutcome.status !== "completed") {
        return { session: rebuilt, outcome: freshOutcome, contextRebuilt: true };
      }
      // Reload again before persisting the fresh cursor (F2): the on-disk record
      // already has the cleared cursor (saved above), plus any write that landed
      // during the fresh turn. advanceCursor re-mints from turnCount 1.
      const advanced = advanceCursor(this.deps.store.load(sessionId) ?? rebuilt, freshOutcome);
      this.deps.store.save(advanced);
      return { session: advanced, outcome: freshOutcome, contextRebuilt: true };
    }

    if (outcome.status !== "completed") return { session: current, outcome };
    // Reload the latest record before persisting the cursor (finding 2): a
    // concurrent addThread/archive during the async turn wrote the whole record;
    // saving our stale pre-turn snapshot would silently erase it. Apply a
    // cursor-only update to the freshly-loaded record instead. Reload → advance →
    // save runs synchronously, so no store write interleaves it.
    const latest = this.deps.store.load(sessionId) ?? current;
    const advanced = advanceCursor(latest, outcome);
    if (advanced !== latest) this.deps.store.save(advanced);
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
    const record = this.deps.recordTranscript;
    const capture = record
      ? (events: readonly HarnessEvent[]) =>
          record({ sessionId: session.id, cwd: spec.cwd, events })
      : undefined;
    return this.deps.port
      .createSession(spec)
      .then((harnessSession) => runTurnToOutcome(harnessSession, prompt, this.deps.emit, capture));
  }
}
