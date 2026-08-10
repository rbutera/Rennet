import type { PatchsetIntent, ReviewIntent } from "@rennet/types";

/**
 * Project the frozen `PatchsetIntent` captured on a patchset (#136) onto the live
 * `ReviewIntent` seam the hypothesis pass and the Decisions runner already consume
 * (`DecisionIntent` is structurally identical, so a `ReviewIntent` value satisfies
 * both). This is the one place capture-shape meets runner-shape.
 *
 * The mapping is deliberately honest and lossy in the safe direction:
 * - `prTitle` / `prBody` carry only when genuinely present. An absent PR body
 *   (`prBodyAbsent`, or a blank string) is dropped, never forwarded as "".
 * - the frozen spec snapshots become the `spec` layer, each labelled by its path,
 *   inlining only the snapshots whose content survived the capture cap.
 * - a no-PR working-tree surface has no title/body, so unless the change touched a
 *   spec the result is `undefined` and the pass degrades to structure-only —
 *   exactly as it did before any intent was captured. Commit subjects are frozen on
 *   the patchset for the spec view but are NOT folded into a PR-body slot they do
 *   not belong in.
 *
 * Returns `undefined` when nothing maps, so an absent-intent patchset and a
 * captured-but-empty intent both degrade identically and honestly.
 */
export function patchsetIntentToReviewIntent(
  intent: PatchsetIntent | undefined,
): ReviewIntent | undefined {
  if (intent === undefined) return undefined;

  const result: { prTitle?: string; prBody?: string; spec?: string } = {};

  if (intent.prTitle !== undefined && intent.prTitle.trim().length > 0) {
    result.prTitle = intent.prTitle;
  }
  if (
    intent.prBodyAbsent !== true &&
    intent.prBody !== undefined &&
    intent.prBody.trim().length > 0
  ) {
    result.prBody = intent.prBody;
  }

  const spec = (intent.specSnapshots ?? [])
    .filter((snapshot) => snapshot.content !== undefined && snapshot.content.trim().length > 0)
    .map((snapshot) => `# ${snapshot.path}\n\n${snapshot.content ?? ""}`)
    .join("\n\n");
  if (spec.length > 0) result.spec = spec;

  return Object.keys(result).length > 0 ? result : undefined;
}
