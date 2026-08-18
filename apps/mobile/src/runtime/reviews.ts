// Aggregated reviews across daemons (issue #383 M1, task 5.1 data). Each daemon's current
// review comes from `app.bootstrap` (the projected review); the hook maps every daemon's
// review to a `ReviewSummary` and returns them for the home list to group. Reachable daemons
// contribute a live row; an unreachable one still contributes its last replica (never dropped),
// stale-marked — the paint-then-reconcile shape of the mobile plan.

import { useEffect, useState } from "react";
import { asProjectedReview, toReviewSummary } from "../lib/projection";
import type { ReviewSummary } from "../lib/review-list";
import type { Runtime } from "./context";

/** The current review row per daemon, refreshed whenever the registry/attention changes. */
export function useAggregatedReviews(runtime: Runtime): ReviewSummary[] {
  const { registry, attentionReviewIds, revision } = runtime;
  const [rows, setRows] = useState<ReviewSummary[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is an intentional refetch trigger — it bumps on any registry/reachability change so the list re-reconciles.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const collected: ReviewSummary[] = [];
      for (const connection of registry.list()) {
        const reachable = connection.status.state === "online";
        try {
          const result = await connection.supervisor.invoke("app.bootstrap", {});
          if (result.review) {
            collected.push(
              toReviewSummary(asProjectedReview(result.review), {
                daemonId: connection.daemon.id,
                reachable,
                attentionReviewIds,
              }),
            );
          }
        } catch {
          // Offline / not yet reconciled: the replica paints elsewhere; skip the live row.
        }
      }
      if (!cancelled) setRows(collected);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [registry, attentionReviewIds, revision]);

  return rows;
}
