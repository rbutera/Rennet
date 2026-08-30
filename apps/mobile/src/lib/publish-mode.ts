import type { Review } from "@rennet/protocol";

export type MobilePublishDecision =
  | { readonly status: "loading" }
  | { readonly status: "mode"; readonly mode: "review" | "pr" }
  | { readonly status: "unavailable"; readonly reason: string };

/** Mirror the desktop's ownership-aware exit routing without importing the DOM package. */
export function mobilePublishDecision(
  review: Pick<Review, "retrospective" | "postTarget"> | undefined,
): MobilePublishDecision {
  if (review === undefined) return { status: "loading" };
  if (review.retrospective) {
    return { status: "unavailable", reason: "Retrospective reviews do not have a publish exit." };
  }
  if (!review.postTarget) return { status: "mode", mode: "pr" };
  if (review.postTarget.viewerDidAuthor) {
    return {
      status: "unavailable",
      reason: "This is your existing pull request; continue its review rounds instead.",
    };
  }
  return { status: "mode", mode: "review" };
}
