import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime, LiveFlaggedAdjudication } from "./runtime";

export function flaggedHandlers(rt: DispatchRuntime) {
  const {
    deps,
    requireReviewById,
    intelligenceSessions,
    flaggedAdjudicationKey,
    liveFlaggedAdjudications,
  } = rt;
  return {
    "flagged.review": async (rawInput) => {
      const name = "flagged.review" as const;
      // The LIVE automated review layer (#32): the finding-generation runner turns
      // the review's diff into real findings. It spends a budgeted model invocation,
      // so — as with `review.canvases` — we resolve the addressed review (a stale or
      // unknown id is refused) and hand the runner the review, never a bare id.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      // Dual-model is the DEFAULT (Rai's mandate, 2026-08-11): an omitted flag runs
      // BOTH provider seats. Only an explicit `false` opts down to single-Claude.
      const deepReview = input.deepReview ?? true;
      const intelligenceSession = intelligenceSessions.enter(review, deepReview, "flagged");
      const run = await deps.flaggedReview(review, deepReview, intelligenceSession);
      const key = flaggedAdjudicationKey({
        reviewId: review.id,
        patchsetId: review.activePatchsetId,
        deepReview,
      });
      if (run.adjudication) {
        const pending: LiveFlaggedAdjudication = { status: "pending" };
        liveFlaggedAdjudications.set(key, pending);
        void run.adjudication.then(
          (enriched) => {
            if (liveFlaggedAdjudications.get(key) !== pending) return;
            liveFlaggedAdjudications.set(key, {
              status: "complete",
              review: { ...enriched, patchsetId: review.activePatchsetId },
            });
          },
          (reason: unknown) => {
            if (liveFlaggedAdjudications.get(key) !== pending) return;
            liveFlaggedAdjudications.set(key, {
              status: "failed",
              reason: reason instanceof Error ? reason.message : String(reason),
            });
          },
        );
      } else {
        liveFlaggedAdjudications.delete(key);
      }
      // Stamp the patchset this result was computed against (#160/P0-2) so the renderer
      // can bind it to the canvases beside it and discard a regenerate-stale result.
      return parseCommandOutput(name, {
        ...run.review,
        patchsetId: review.activePatchsetId,
        ...(run.adjudication ? { lateEnrichmentScheduled: true as const } : {}),
      });
    },
    "flagged.adjudication": async (rawInput) => {
      const name = "flagged.adjudication" as const;
      const input = parseCommandInput(name, rawInput);
      const result = liveFlaggedAdjudications.get(flaggedAdjudicationKey(input));
      if (!result) return parseCommandOutput(name, { status: "absent" });
      if (result.status === "pending") return parseCommandOutput(name, result);
      if (result.status === "failed") return parseCommandOutput(name, result);
      return parseCommandOutput(name, { status: "complete", review: result.review });
    },
  } satisfies Record<string, CommandHandler>;
}
