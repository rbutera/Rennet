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
// ⚠️ THE HONESTY BOUNDARY (Rule 80, and this whole issue's doctrine). `abortAll`
// reports how many turns it SIGNALLED — an abort REQUEST count — never how many
// children stopped. Codex's exec is force-killed by execa. But the claude child's
// PID is unreachable through the SDK's narrowed `query()`, so a claude child that
// ignores its abort cannot be observed to have exited and cannot be force-reaped.
// "abort requested" and "child exited" are different states, and this registry only
// ever asserts the first. It does not, and structurally cannot, claim the second.
// ─────────────────────────────────────────────────────────────────────────────

/** The outcome of a bulk abort: the number of turns SIGNALLED (an abort request
 *  count, never a confirmed-exit count — see the honesty boundary above). */
export interface AbortAllOutcome {
  readonly signalled: number;
}

export class LiveTurnRegistry {
  private readonly turns = new Map<string, AbortController>();

  /**
   * Enter a turn. Returns the AbortController whose `.signal` the caller threads into
   * the model backends. The caller MUST `settle(turnId)` when the turn finishes (in a
   * `finally`), or the registry leaks a controller for a turn that is already done. A
   * repeated id replaces the prior controller (a fresh turn reusing an id) rather than
   * silently dropping the new one.
   */
  register(turnId: string): AbortController {
    const controller = new AbortController();
    this.turns.set(turnId, controller);
    return controller;
  }

  /** Leave a turn — it settled (completed / errored / aborted). Idempotent: settling a
   *  turn that is not (or no longer) tracked is a no-op. */
  settle(turnId: string): void {
    this.turns.delete(turnId);
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
    for (const controller of this.turns.values()) {
      controller.abort();
      signalled += 1;
    }
    this.turns.clear();
    return { signalled };
  }
}
