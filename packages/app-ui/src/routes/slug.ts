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
  | { readonly status: "not-found"; readonly slug: string };

export function useSlugResolution(slug: string): SlugResolution {
  // A stable commandId per slug: review.load carries one for progress correlation, but a
  // fresh uuid each render would churn the cache key. Memoized on the slug, so a remount
  // refetches (fresh id) while a re-render reuses the same key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `slug` is the intended regeneration key — a new slug must mint a new commandId — not a body reference.
  const commandId = useMemo(() => crypto.randomUUID(), [slug]);
  const { data, error, pending } = useCommand("review.load", { commandId, reviewId: slug });
  if (data) return { status: "review", reviewId: data.review.id, review: data.review };
  if (error) return { status: "not-found", slug };
  if (pending) return { status: "pending" };
  return { status: "not-found", slug };
}
