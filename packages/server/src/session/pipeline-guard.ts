// ─────────────────────────────────────────────────────────────────────────────
// The drafting pipeline start guard: idempotent per session + generation (B09 cluster 5).
//
// Re-entering a row whose session is already live must NOT double-start the lens
// pipeline. This guard keys an in-flight start on (sessionId, patchsetGeneration):
// a second entry mid-generation returns the SAME start promise, never invoking the
// pipeline again. A completed generation stays memoised (its boards exist — never
// re-drafted); a FAILED start is dropped so a fresh entry can retry, never wedging
// the session forever (a product fix, not a gate — the review must stay startable).
//
// The guard OWNS no writer: `start` is injected by the cluster-6 composition root
// (the sanctioned `runLensPipeline`), so every board write goes through the one
// path. A new patchset is a new generation id — a new key — so the successor
// generation drafts freely.
// ─────────────────────────────────────────────────────────────────────────────

export class PipelineStartGuard {
  /** In-flight/settled starts keyed `${sessionId}::${patchsetGeneration}`. A rejected
   *  start deletes its key (retriable); a resolved one stays (never re-drafted). */
  readonly #starts = new Map<string, Promise<unknown>>();

  /**
   * Start the drafting pipeline for a session's current generation AT MOST ONCE.
   * A concurrent or later call with the same (session, generation) returns the
   * existing promise; the `start` thunk runs only on the first call for that key.
   */
  start<R>(sessionId: string, patchsetGeneration: string, start: () => Promise<R>): Promise<R> {
    const key = `${sessionId}::${patchsetGeneration}`;
    const existing = this.#starts.get(key) as Promise<R> | undefined;
    if (existing !== undefined) return existing;
    const run = start();
    this.#starts.set(key, run);
    // Fire-and-forget cleanup: drop the key on failure so a crashed generation can
    // be retried; a resolved key stays so a re-entry never re-drafts existing boards.
    void run.catch(() => this.#starts.delete(key));
    return run;
  }
}
