import { materializeSnapshot } from "@rennet/core";
import type { OwnershipRule, ProjectSnapshotManifest, Review } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Review ownership source (issue #35, F4).
//
// The blast-radius CODEOWNERS-overlap signal fires only when it is HANDED the
// review's ownership rules. `buildReviewCanvases` defaults missing ownership to
// `[]`, and the desktop composition used to supply none — so the signal could
// never fire in the real app even when both owner groups sat in the built
// ProjectSnapshot. This reads those rules off the review's snapshot the same
// content-addressed way the context reader does (manifest → materialize → the
// `ownership` shard), so the composition can thread them into the pipeline.
//
// Honest degradation, exactly like `loadReviewConventions`: no resolvable
// repoKey, no built snapshot, or an unmaterialisable one ⇒ `[]`, and the overlap
// signal simply does not fire (never a claim that the change is single-owner).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewOwnershipDeps {
  /** The snapshot store's manifest reader (keyed by the escaped repo path). */
  loadManifest(repoKey: string): ProjectSnapshotManifest | null;
  /** The snapshot store's shard reader (content-addressed by digest). */
  loadShard(repoKey: string, digest: string): string | undefined;
  /** Resolve a review's `repositoryRoot` to its snapshot store key, or null. */
  resolveRepoKey(repositoryRoot: string): Promise<string | null>;
}

/**
 * The CODEOWNERS rules for a review, from its built ProjectSnapshot. Returns `[]`
 * — never throws — when the repo has no resolvable key, no stored manifest, or a
 * snapshot that cannot be materialised (a shard is missing/corrupt). The rules are
 * in file order (git's last-match-wins is order-significant), exactly as the
 * `ownership` shard stored them.
 */
export async function loadReviewOwnership(
  deps: ReviewOwnershipDeps,
  review: Pick<Review, "repositoryRoot">,
): Promise<readonly OwnershipRule[]> {
  const repoKey = await deps.resolveRepoKey(review.repositoryRoot);
  if (!repoKey) return [];
  const manifest = deps.loadManifest(repoKey);
  if (!manifest) return [];
  const result = materializeSnapshot(manifest, (digest) => deps.loadShard(repoKey, digest));
  return result.ok ? result.snapshot.ownership : [];
}
