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
  } satisfies Record<string, CommandHandler>;
}
