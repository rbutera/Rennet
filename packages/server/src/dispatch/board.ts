import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The lens-board READ dispatch (C05 cluster 8, bound in C18). `LensBoardSchema` froze in
 * B3 with the command left to "B4/B10's business"; this serves it from the real substrate:
 * the lens pipeline writes each board's elements through `whiteboard.apply` and its
 * board-level coverage to the board-meta store, and the composition root's
 * `lensBoardForReview` seam rebuilds the projection for a `(review, generation, lens)`.
 *
 * `board: null` is the honest MISSING answer — that lens drafted no board that generation
 * (absent-not-disabled; the lens switcher renders no segment for it). A board is never
 * fabricated, and a board that cannot be read fails loudly rather than reading as missing.
 */
export function boardHandlers(rt: DispatchRuntime) {
  return {
    "board.read": async (rawInput) => {
      const name = "board.read" as const;
      const input = parseCommandInput(name, rawInput);
      // Freshness-pin the review (an unknown id is a genuine error, like every review read).
      rt.requireReviewById(input.reviewId);
      const board =
        (await rt.deps.lensBoardForReview?.(input.reviewId, input.generation, input.lens)) ?? null;
      const absence =
        board === null
          ? await rt.deps.lensAbsenceForReview?.(input.reviewId, input.generation, input.lens)
          : undefined;
      const failure =
        board === null && absence === undefined
          ? await rt.deps.lensFailureForReview?.(input.reviewId, input.generation, input.lens)
          : undefined;
      return parseCommandOutput(name, {
        board,
        ...(absence === undefined ? {} : { absence }),
        ...(failure === undefined ? {} : { failure: failure.message }),
        // The classification travels with the message (#549). Without it the client can
        // only assume terminal, which is what it used to do for a lens whose seat simply
        // did not emit — a lens another attempt could still draft.
        ...(failure?.account === undefined ? {} : { failureAccount: failure.account }),
      });
    },
    /**
     * The catch-up half of the element stream (`lens-board-tools` D11, task 4.1).
     *
     * `board.read` above serves what the pipeline PERSISTED at settle; this serves the
     * board a seat is writing right now, out of the daemon's own live hub, so a surface
     * that mounts mid-draft starts from what is on the board rather than from a hole the
     * live frames can never fill. `revision` is the frame it is current with, so the
     * client resumes folding from exactly there.
     *
     * `draft: null` is the honest missing answer — no lane of that generation ever opened
     * this lens on this daemon. It is never a drafting board invented over a settled one.
     */
    "board.draft": async (rawInput) => {
      const name = "board.draft" as const;
      const input = parseCommandInput(name, rawInput);
      rt.requireReviewById(input.reviewId);
      const draft =
        rt.deps.lensDraftForReview?.(input.reviewId, input.generation, input.lens) ?? null;
      return parseCommandOutput(name, { draft });
    },
  } satisfies Record<string, CommandHandler>;
}
