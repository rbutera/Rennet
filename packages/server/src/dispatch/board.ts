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
      return parseCommandOutput(name, { board, ...(absence === undefined ? {} : { absence }) });
    },
  } satisfies Record<string, CommandHandler>;
}
