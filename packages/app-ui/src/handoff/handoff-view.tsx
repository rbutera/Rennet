import type { Review } from "@rennet/protocol";
import { AskBasket } from "./ask-basket";
import { resolveEntryMode } from "./handoff-data";
import { PostReviewLane, type PostReviewLaneProps } from "./post-review-lane";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off view (C08 cluster 4, Objective clause 3, R31) — a view toggle on the review
// workspace, exactly like the board and diff. It dispatches by the ENTRY MODE the single
// `handoff-data.ts` seam resolves: a teammate PR gets the Post Review lane; a retrospective
// review gets NO exits (law 10 — it renders nothing); your own branch gets the rounds lanes.
//
// The own-branch rounds lanes are cluster 5's surface (`rounds-lanes.tsx` + the two-state
// Changes ⇄ the-PR-is-the-page). Until they land, the staged asks ARE the honest own-branch
// content the reviewer is gathering to dispatch — a real surface, not a stub. Cluster 5
// replaces this branch when it builds the rounds lanes.
// ─────────────────────────────────────────────────────────────────────────────

export interface HandoffViewProps {
  readonly review: Review;
  /** The Post Review egress, threaded to the teammate-PR lane (wired in cluster 6). */
  readonly onPost?: PostReviewLaneProps["onPost"];
}

export function HandoffView({ review, onPost }: HandoffViewProps) {
  const mode = resolveEntryMode(review);
  if (mode === "retrospective") return null;
  if (mode === "teammate-pr") return <PostReviewLane review={review} onPost={onPost} />;
  return (
    <div className="mx-auto w-full max-w-[720px] px-8 py-8">
      <AskBasket />
    </div>
  );
}
