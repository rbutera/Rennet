// ─────────────────────────────────────────────────────────────────────────────
// The live-turn registry (issue #251, criterion 4 — scoped reaping on quit).
//
// Quitting the app while a conversation turn is in flight used to leave the model
// child running: persistence recovered the RECORD as `interrupted` (the crash-
// recovery transform), but the actual subprocess was never asked to stop. This
// registry closes that loop. Each `review.ask` turn ENTERS the registry when it
// starts and LEAVES when it settles — completed, errored, or aborted — so the set
// holds exactly the turns whose model child may still be running. A registry that
// only ever grew would be a leak; `settle` is what keeps it honest.
//
// On Electron's `before-quit` the composition root calls `abortAll()`, which fires
// every held AbortController's signal. That signal reaches BOTH backends through
// the seams they already expose: the claude turn via the SDK's `abortController`
// option, and the codex exec via execa's `cancelSignal`.
//
// The registry ALSO tracks a streaming turn's coalesced body (issue #382 M2,
// finding 5): a turn that is genuinely still running in a surviving main process is
// LIVE, not interrupted. `review.reattach` reads `inFlightFor(reviewId)` so the
// phone resumes the real in-flight body (the cursor) instead of the crash-recovery
// transform painting a still-running turn as stopped.
//
// ⚠️ THE HONESTY BOUNDARY (Rule 80, and this whole issue's doctrine). `abortAll`
// reports how many turns it SIGNALLED — an abort REQUEST count — never how many
// children stopped. Codex's exec is force-killed by execa. But the claude child's
// PID is unreachable through the SDK's narrowed `query()`, so a claude child that
// ignores its abort cannot be observed to have exited and cannot be force-reaped.
// "abort requested" and "child exited" are different states, and this registry only
// ever asserts the first. It does not, and structurally cannot, claim the second.
// ─────────────────────────────────────────────────────────────────────────────

import type { InFlightTurn, SessionTranscriptRow, StreamChannel } from "@rennet/protocol";

/** The outcome of a bulk abort: the number of turns SIGNALLED (an abort request
 *  count, never a confirmed-exit count — see the honesty boundary above). */
export interface AbortAllOutcome {
  readonly signalled: number;
}

/** The live-stream descriptor a STREAMING (backgroundable) turn registers so reattach can
 *  report it as real in-flight state. A one-shot ask has none and is never in `inFlightFor`. */
interface LiveStream {
  readonly threadId: string;
  readonly channel: StreamChannel;
  /** Known only at completion; while streaming the reattach model label falls back to "harness". */
  model?: string;
  /** The coalesced deltas so far — the cursor the phone resumes on reattach. */
  body: string;
  readonly time: string;
  /** Latest ordered activity projection; replaced atomically as events arrive. */
  rows?: readonly SessionTranscriptRow[];
}

interface LiveTurn {
  readonly controller: AbortController;
  readonly reviewId?: string;
  readonly stream?: LiveStream;
}

export class LiveTurnRegistry {
  private readonly turns = new Map<string, LiveTurn>();

  /**
   * Enter a turn. Returns the AbortController whose `.signal` the caller threads into
   * the model backends. The caller MUST `settle(turnId)` when the turn finishes (in a
   * `finally`), or the registry leaks a controller for a turn that is already done.
   *
   * REJECTS a duplicate LIVE id (issue #382 M2, finding 7): registering a turnId that is
   * already in flight throws rather than replacing the prior controller. A `Map` keyed by
   * turnId can hold exactly one controller per id, so a silent replace would orphan turn A's
   * controller (unstoppable, unreapable) and let a "Stop" or settle aimed at B reach A. Turn
   * ids are unique per live turn; a collision is a bug, surfaced truthfully. A SEQUENTIAL reuse
   * (a fresh turn reusing an id after the prior settled) is fine — the id is free once settled.
   *
   * `reviewId`, when given, scopes the turn so `abortReview` (the client "Stop") can stop it.
   * `stream`, when given, marks the turn as a live streaming turn `inFlightFor` reports.
   */
  register(
    turnId: string,
    reviewId?: string,
    stream?: { threadId: string; channel: StreamChannel },
  ): AbortController {
    if (this.turns.has(turnId)) {
      throw new Error(
        `LiveTurnRegistry: turn ${turnId} is already in flight — a duplicate live id would orphan the prior turn`,
      );
    }
    const controller = new AbortController();
    this.turns.set(turnId, {
      controller,
      ...(reviewId === undefined ? {} : { reviewId }),
      ...(stream === undefined
        ? {}
        : { stream: { ...stream, body: "", time: new Date().toISOString() } }),
    });
    return controller;
  }

  /** Leave a turn — it settled (completed / errored / aborted). Idempotent: settling a
   *  turn that is not (or no longer) tracked is a no-op. */
  settle(turnId: string): void {
    this.turns.delete(turnId);
  }

  /** Append a streamed delta to a live turn's coalesced body (the reattach cursor). A turn with
   *  no live descriptor, or an unknown id, is a no-op. */
  appendDelta(turnId: string, delta: string): void {
    const turn = this.turns.get(turnId);
    if (turn?.stream) turn.stream.body += delta;
  }

  /** Replace a live turn's rich activity snapshot. Unknown/non-streaming ids are no-ops. */
  setRows(turnId: string, rows: readonly SessionTranscriptRow[]): void {
    const turn = this.turns.get(turnId);
    if (turn?.stream) turn.stream.rows = rows;
  }

  /** The coalesced body streamed so far for a turn, or "" — used to persist the partial answer
   *  of an interrupted turn truthfully rather than a blank. */
  bodyOf(turnId: string): string {
    return this.turns.get(turnId)?.stream?.body ?? "";
  }

  /** The turns still genuinely streaming on ONE review (main-alive live case, #382 M2 finding 5),
   *  as the `inFlight` re-attach reports so the phone resumes the real body, never a stopped turn.
   *  While streaming the model is usually unknown, so it falls back to the renderer's own label. */
  inFlightFor(reviewId: string): InFlightTurn[] {
    const out: InFlightTurn[] = [];
    for (const [turnId, turn] of this.turns) {
      if (turn.reviewId !== reviewId || !turn.stream) continue;
      out.push({
        threadId: turn.stream.threadId,
        turnId,
        channel: turn.stream.channel,
        model: turn.stream.model ?? "harness",
        bodySoFar: turn.stream.body,
        time: turn.stream.time,
        ...(turn.stream.rows === undefined ? {} : { rows: [...turn.stream.rows] }),
      });
    }
    return out;
  }

  /**
   * Abort every in-flight turn on ONE review (the client "Stop", issue #382 M2). Fires each
   * matching turn's AbortController — the same signal `before-quit` uses, so both backends
   * (claude via the SDK, codex via execa's cancelSignal) cancel — and returns how many turns
   * were SIGNALLED (an abort-request count, never a confirmed-exit count — see the honesty
   * boundary above). The turns leave the registry through their own `settle` in the ask
   * handler's `finally`, exactly as a completed turn does; this only requests the stop. Safe
   * with nothing in flight (returns 0) and safe to call twice (a double-tap Stop).
   */
  abortReview(reviewId: string): number {
    let signalled = 0;
    for (const turn of this.turns.values()) {
      if (turn.reviewId !== reviewId) continue;
      turn.controller.abort();
      signalled += 1;
    }
    return signalled;
  }

  /** The turn ids currently in flight, for observability and tests. */
  activeTurnIds(): string[] {
    return [...this.turns.keys()];
  }

  /** How many turns are currently in flight. */
  get size(): number {
    return this.turns.size;
  }

  /**
   * Abort every in-flight turn and clear the registry. Returns the number of turns
   * SIGNALLED — an abort REQUEST count, not a confirmed-exit count (see the honesty
   * boundary at the top of this file). Safe to call with nothing in flight (returns 0),
   * and safe to call twice (the second call finds an empty registry and returns 0).
   */
  abortAll(): AbortAllOutcome {
    let signalled = 0;
    for (const turn of this.turns.values()) {
      turn.controller.abort();
      signalled += 1;
    }
    this.turns.clear();
    return { signalled };
  }
}
