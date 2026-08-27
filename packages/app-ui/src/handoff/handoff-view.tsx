import type { Review } from "@rennet/protocol";
import { resolveEntryMode } from "./handoff-data";
import { PostReviewLane, type PostReviewLaneProps } from "./post-review-lane";
import { RoundsLanes, type RoundsLanesProps } from "./rounds-lanes";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off view (C08 cluster 4, Objective clause 3, R31) — a view toggle on the review
// workspace, exactly like the board and diff. It dispatches by the ENTRY MODE the single
// `handoff-data.ts` seam resolves: a teammate PR gets the Post Review lane; a retrospective
// review gets NO exits (law 10 — it renders nothing); your own branch gets the rounds lanes
// (cluster 5's two-state Changes ⇄ the-PR-is-the-page surface).
// ─────────────────────────────────────────────────────────────────────────────

export interface HandoffViewProps {
  readonly review: Review;
  /** The Post Review egress, threaded to the teammate-PR lane (wired in cluster 6). */
  readonly onPost?: PostReviewLaneProps["onPost"];
  /** The own-branch PR draft, threaded to the rounds lanes (B11 draft; cluster 8/6 wire it). */
  readonly pr?: RoundsLanesProps["pr"];
  /** Dispatch a work-order round from the rounds lanes (the C9 run is out of scope). */
  readonly onDispatch?: RoundsLanesProps["onDispatch"];
  /** The Open-Pull-Request egress, threaded to the rounds lanes (wired in cluster 6). */
  readonly onOpenPr?: RoundsLanesProps["onOpenPr"];
}

export function HandoffView({ review, onPost, pr, onDispatch, onOpenPr }: HandoffViewProps) {
  const mode = resolveEntryMode(review);
  if (mode === "retrospective") return null;
  if (mode === "teammate-pr") return <PostReviewLane review={review} onPost={onPost} />;
  return <RoundsLanes review={review} pr={pr} onDispatch={onDispatch} onOpenPr={onOpenPr} />;
}
