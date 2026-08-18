// The home review-list derivation (issue #383 M1, task 5.1). Cross-daemon aggregation,
// running/needs-you pinning, recency grouping, freshness as a row fact — all pure, so the
// list logic unit-tests without React Native. The screens build the `ReviewSummary` rows
// from the R19 projection (see `projection.ts`) and hand them here for ordering.
//
// Note on `running`/`needsYou`: the projected review carries no such field yet (documented
// gap, flagged to the team). `running` is derived app-side from a re-review in flight
// (`pendingPatchsetId`), `needsYou` from active attention / the flagged queue — see
// `projection.ts`. This module only orders whatever those predicates decided.

/** One review row across any daemon, ready to order. */
export interface ReviewSummary {
  readonly daemonId: string;
  readonly reviewId: string;
  readonly repoDisplayName: string;
  /** Recency key (epoch ms) — the latest patchset's time. */
  readonly updatedAt: number;
  /** A turn/re-review is in flight (pinned as running). */
  readonly running: boolean;
  /** A pending ask or attention flag wants the user (pinned as needs-you). */
  readonly needsYou: boolean;
  /** The daemon is reachable now; false ⇒ this row paints from the replica. */
  readonly reachable: boolean;
  /** The row is stale (replica behind live, or the review is invalid) — a freshness fact. */
  readonly stale: boolean;
}

export type RecencyLabel = "Today" | "Yesterday" | "This week" | "Earlier";

export interface RecencyGroup {
  readonly label: RecencyLabel;
  readonly reviews: readonly ReviewSummary[];
}

export interface GroupedReviews {
  /** Running + needs-you rows, pinned above the recency groups (needs-you first). */
  readonly pinned: readonly ReviewSummary[];
  /** The remaining reviews, grouped by recency (only non-empty groups appear). */
  readonly groups: readonly RecencyGroup[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function recencyLabel(updatedAt: number, now: number): RecencyLabel {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return "Today";
  if (updatedAt >= startOfToday - DAY_MS) return "Yesterday";
  if (updatedAt >= startOfToday - 7 * DAY_MS) return "This week";
  return "Earlier";
}

const byUpdatedDesc = (a: ReviewSummary, b: ReviewSummary): number => b.updatedAt - a.updatedAt;

/**
 * Order reviews for the home list: pin running + needs-you (needs-you ranked first, then
 * running, then recency), and group the rest by recency. Aggregation is just concatenation —
 * the caller passes rows from every paired daemon. Deterministic and stable.
 */
export function groupReviews(reviews: readonly ReviewSummary[], now: number): GroupedReviews {
  const pinned = reviews
    .filter((r) => r.needsYou || r.running)
    .sort((a, b) => {
      // needs-you outranks running; within a rank, most recent first.
      if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
      if (a.running !== b.running) return a.running ? -1 : 1;
      return byUpdatedDesc(a, b);
    });

  const rest = reviews.filter((r) => !r.needsYou && !r.running);
  const order: RecencyLabel[] = ["Today", "Yesterday", "This week", "Earlier"];
  const buckets = new Map<RecencyLabel, ReviewSummary[]>();
  for (const review of rest) {
    const label = recencyLabel(review.updatedAt, now);
    const bucket = buckets.get(label) ?? [];
    bucket.push(review);
    buckets.set(label, bucket);
  }
  const groups: RecencyGroup[] = [];
  for (const label of order) {
    const bucket = buckets.get(label);
    if (bucket && bucket.length > 0) {
      groups.push({ label, reviews: bucket.sort(byUpdatedDesc) });
    }
  }
  return { pinned, groups };
}
