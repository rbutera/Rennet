// Projection adapters (issue #383 M1, task 5.5). The app consumes ONLY the R19 projected
// contract: a projected review names a repo by `{ repoKey, displayName, relativePath }` —
// never a host-absolute path. These adapters read exactly those projected fields and build
// the display models the screens render, so a host path structurally cannot reach the UI.
// Pure and framework-free (unit-tested against the checked-in public-schema fixtures).

import type { ReviewSummary } from "./review-list";

/** A projected repo reference — the ONLY way the app names a file's repository (no host path). */
export interface ProjectedRepoReference {
  readonly repoKey: string;
  readonly displayName: string;
  readonly relativePath?: string;
}

/** The subset of a projected review the home list reads. */
export interface ProjectedReviewLike {
  readonly id: string;
  readonly repositoryRoot: ProjectedRepoReference;
  readonly patchsets: ReadonlyArray<{ readonly id: string; readonly createdAt: string }>;
  readonly activePatchsetId: string;
  readonly pendingPatchsetId?: string;
  readonly status: "current" | "invalid";
}

/**
 * Coerce a command output to its PROJECTED shape at the boundary. The protocol's static
 * command-output types are the RAW review (repositoryRoot is a host string); but the mobile app
 * is always a projected connection, so the daemon runs every output through the R19 projection
 * codec before it reaches the wire — the value at runtime IS a projected review. This cast names
 * that reality in one place (the projection is a runtime codec the static types do not capture).
 */
export function asProjectedReview(review: unknown): ProjectedReviewLike {
  return review as ProjectedReviewLike;
}

/** The display label for a repo reference: the projected display name and its relative path. */
export function repoReferenceLabel(ref: ProjectedRepoReference): {
  displayName: string;
  relativePath: string;
} {
  return { displayName: ref.displayName, relativePath: ref.relativePath ?? "" };
}

/** The recency time of a review: its latest patchset's `createdAt`, in epoch ms. */
export function latestPatchsetTime(review: ProjectedReviewLike): number {
  let latest = 0;
  for (const patchset of review.patchsets) {
    const t = Date.parse(patchset.createdAt);
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  return latest;
}

export interface SummaryContext {
  readonly daemonId: string;
  /** The daemon is reachable now (false ⇒ this row paints from the replica, stale-marked). */
  readonly reachable: boolean;
  /** Review ids with an active attention item (needs-you), from the attention layer + flagged queue. */
  readonly attentionReviewIds: ReadonlySet<string>;
}

/**
 * Build a home-list row from a projected review. `running` is a re-review in flight
 * (`pendingPatchsetId`); `needsYou` is an active attention item on this review; `stale` is an
 * unreachable daemon or an invalidated review. This is the documented app-side derivation for
 * the fields the projection does not (yet) carry — see `review-list.ts`.
 */
export function toReviewSummary(review: ProjectedReviewLike, ctx: SummaryContext): ReviewSummary {
  return {
    daemonId: ctx.daemonId,
    reviewId: review.id,
    repoDisplayName: review.repositoryRoot.displayName,
    updatedAt: latestPatchsetTime(review),
    running: review.pendingPatchsetId !== undefined,
    needsYou: ctx.attentionReviewIds.has(review.id),
    reachable: ctx.reachable,
    stale: !ctx.reachable || review.status === "invalid",
  };
}
