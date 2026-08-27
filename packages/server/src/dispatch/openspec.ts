import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function openspecHandlers(rt: DispatchRuntime) {
  const { deps, requireReviewById } = rt;
  return {
    "openspec.change": async (rawInput) => {
      const name = "openspec.change" as const;
      // Parse-on-open of the change the reviewed patchset selected. Deterministic —
      // no model spend. Resolve the addressed review (a stale/unknown id is refused),
      // then read + parse. No reader wired, or no change in the patchset ⇒ `null`,
      // and the Spec angle shows its honest empty state.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      return parseCommandOutput(
        name,
        deps.openSpecChange ? await deps.openSpecChange(review) : null,
      );
    },
    "openspec.coverage": async (rawInput) => {
      const name = "openspec.coverage" as const;
      // The produced hunk↔requirement mapping over the review's change. Spends a
      // budgeted model turn, so — like flagged.review — we resolve the addressed
      // review (a stale/unknown id is refused) and hand the runner the review.
      // Unwired ⇒ `null` (the Spec view renders no coverage chips), never a fixture.
      const input = parseCommandInput(name, rawInput);
      const review = requireReviewById(input.reviewId);
      return parseCommandOutput(
        name,
        deps.openSpecCoverage ? await deps.openSpecCoverage(review) : null,
      );
    },
  } satisfies Record<string, CommandHandler>;
}
