import type { Decomposition, FlaggedReview } from "@rennet/types";

/** Attach deterministic ingestion blockers to either model-review outcome. */
export function stampBlockingStates(
  result: FlaggedReview,
  decomposition: Pick<Decomposition, "blockingStates">,
): FlaggedReview {
  return { ...result, blockingStates: decomposition.blockingStates };
}
