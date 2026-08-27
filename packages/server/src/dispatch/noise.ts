import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function noiseHandlers(rt: DispatchRuntime) {
  const { deps, requireReviewById } = rt;
  return {
    "noise.review": async (rawInput) => {
      const name = "noise.review" as const;
      // The LIVE noise-classification runner (#34): the noise-generation runner turns
      // the review's diff into real grouped churn. It spends a budgeted model
      // invocation, so — as with `flagged.review` — we resolve the addressed review
      // (a stale or unknown id is refused) and hand the runner the review, never a
      // bare id.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      return parseCommandOutput(name, await deps.noiseReview(review));
    },
  } satisfies Record<string, CommandHandler>;
}
