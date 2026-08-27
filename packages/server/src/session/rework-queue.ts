// ─────────────────────────────────────────────────────────────────────────────
// Rework one-shot workers, serialized per document (#466 res., B09 cluster 4).
//
// Rework is NOT the interactive session. A rework request for a board runs a FRESH
// one-shot refine turn — reusing the refine-comment primitive (`createLiveRefinePort`),
// never a new refiner — and lands its result on the board through the sanctioned
// `WhiteboardClient` (reconciliation 4: the ONE board-op writer, never a second).
// Two rework requests for the SAME board serialize behind a per-document lock so
// their writes never race; requests for different boards overlap freely.
//
// The per-document promise-tail mirrors `SessionTurnLoop`'s per-session serializer
// (`turn-loop.ts`) — a per-KEY chain, not a global lock. Replicated rather than
// shared: the pattern is a handful of lines and `turn-loop.ts` is a frozen sibling
// cluster; a shared helper would couple two clusters for no real saving.
// ─────────────────────────────────────────────────────────────────────────────

import type { DraftOp, WhiteboardClient } from "@rennet/adapters";
import type { RefinementResult } from "@rennet/core";
import type { LiveRefineInput } from "../refine-comment-live";

/** One rework request: which board to rework, and the refine input the worker runs. */
export interface ReworkRequest {
  /** The board/document being reworked — the per-document serialization key. */
  readonly boardId: string;
  /** The refine input the one-shot worker reasons over (reuses the refine primitive). */
  readonly input: LiveRefineInput;
}

/**
 * The outcome of one rework: the refine result, plus the write when one landed.
 * `applied` is absent when the refine produced nothing to write (no-change /
 * unavailable / failed) — the honest "nothing changed on the board" signal.
 */
export interface ReworkOutcome {
  readonly result: RefinementResult;
  readonly applied?: Awaited<ReturnType<WhiteboardClient["apply"]>>;
}

export interface ReworkQueueDeps {
  /**
   * The one-shot refine turn (`createLiveRefinePort`) — a FRESH turn per request,
   * never the resident session's cursor/resume. Injecting the refine port directly
   * (not a `SessionTurnLoop`) is what makes rework one-shot by construction.
   */
  readonly refine: (input: LiveRefineInput) => Promise<RefinementResult>;
  /**
   * The sanctioned board writer — the ONLY path board ops reach the store
   * (reconciliation 4). Injected as a `Pick`, following the lens-pipeline precedent.
   */
  readonly whiteboard: Pick<WhiteboardClient, "apply">;
  /**
   * Map a rework result to the ops that land it. Returns `[]` when nothing should be
   * written (e.g. a no-change/failed result). The board-op vocabulary is the caller's
   * concern, not the queue's — the queue owns dispatch, serialization, and routing.
   */
  readonly toOps: (boardId: string, result: RefinementResult) => readonly DraftOp[];
  /** The actor the write is attributed to. */
  readonly actor: string;
}

/**
 * Dispatches rework as one-shot workers, serialized per document. `submit` returns a
 * promise that resolves after this request's turn AND its write complete; a same-board
 * request queued while it runs starts only once this one commits.
 */
export class ReworkQueue {
  // Per-document promise tails (same shape as `SessionTurnLoop.#tails` — per key,
  // not global). The stored tail swallows rejection so one failed rework never
  // wedges the queue; the returned promise still carries the real outcome.
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ReworkQueueDeps) {}

  submit(request: ReworkRequest): Promise<ReworkOutcome> {
    const prior = this.#tails.get(request.boardId) ?? Promise.resolve();
    const run = prior.then(() => this.#runOnce(request));
    this.#tails.set(
      request.boardId,
      run.catch(() => undefined),
    );
    return run;
  }

  async #runOnce(request: ReworkRequest): Promise<ReworkOutcome> {
    // One-shot: a fresh refine turn, never the resident cursor.
    const result = await this.deps.refine(request.input);
    const ops = this.deps.toOps(request.boardId, result);
    if (ops.length === 0) return { result };
    // Routes through the sanctioned client — never a second board writer.
    const applied = await this.deps.whiteboard.apply(request.boardId, ops, this.deps.actor);
    return { result, applied };
  }
}
