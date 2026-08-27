import type { Review } from "@rennet/protocol";
import { useMemo } from "react";
import { useCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// Slug resolution (C01 §4.4, reconciliation 4). `/s/:slug` presumes #466 durable-
// session identity, which lands with B9. Until then the slug resolves against today's
// review command — a slug IS a review id — through the data seam. This hook is the
// SINGLE swap point: when B9 session projections arrive, only this file changes (from
// `review.load` to the session-resolve command). An unresolvable slug is an honest
// not-found, never a crash.
// ─────────────────────────────────────────────────────────────────────────────

export type SlugResolution =
  | { readonly status: "pending" }
  | { readonly status: "review"; readonly reviewId: string; readonly review: Review }
  | { readonly status: "not-found"; readonly slug: string }
  | { readonly status: "error"; readonly slug: string; readonly error: unknown };

/** The daemon's typed missing-review signal: server dispatch throws exactly this for an
 *  unknown reviewId (packages/server dispatch.ts `requireReviewById`), and the WS bridge
 *  reconstructs it as `new Error(message)`. Matching this — and ONLY this — is what
 *  separates a genuinely unknown slug from a disconnect / IPC fault / server exception,
 *  so those never masquerade as "nothing here". */
const MISSING_REVIEW_MESSAGE = "Review not found";

function isMissingReview(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_REVIEW_MESSAGE;
}

export function useSlugResolution(slug: string): SlugResolution {
  // A stable commandId per slug: review.load carries one for progress correlation, but a
  // fresh uuid each render would churn the cache key. Memoized on the slug, so a remount
  // refetches (fresh id) while a re-render reuses the same key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `slug` is the intended regeneration key — a new slug must mint a new commandId — not a body reference.
  const commandId = useMemo(() => crypto.randomUUID(), [slug]);
  const { data, error } = useCommand("review.load", { commandId, reviewId: slug });
  if (data) return { status: "review", reviewId: data.review.id, review: data.review };
  if (error) {
    return isMissingReview(error)
      ? { status: "not-found", slug }
      : { status: "error", slug, error };
  }
  return { status: "pending" };
}
