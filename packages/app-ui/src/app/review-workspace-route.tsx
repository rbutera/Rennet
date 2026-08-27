import type { Review } from "@rennet/protocol";
import { useSearch } from "wouter";
import { DiffViewContainer } from "../review";
import { readSessionQuery } from "../routes/url";

// The review workspace surface (B2 stub → Track C rebuild). The canvas-era surface was
// deleted in the delete-first cutover; the Board rebuild restores it view-by-view over
// `?view`. C6 owns ONLY the `diff` branch — every other value (board = C5's default,
// map/handoff/rounds later) keeps the honest placeholder below, written so C5 slots its
// board branch beside this switch. No behavior, no gate — the product is mid-rebuild.
export function ReviewWorkspace({ review }: { review: Review }) {
  const view = readSessionQuery(new URLSearchParams(useSearch())).view;
  if (view === "diff") return <DiffViewContainer review={review} />;
  return (
    <main
      className="review-workspace-stub grid min-h-screen place-content-center justify-items-center gap-2 bg-canvas p-8 text-center"
      role="status"
    >
      <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        REVIEW
      </p>
      <h1 className="m-0 font-display text-xl font-medium text-ink">
        The review surface is being rebuilt.
      </h1>
      <p className="m-0 max-w-[520px] leading-relaxed text-ink-soft">
        Rennet captured this review ({review.repositoryRoot.split("/").at(-1)}). The Board review
        surface lands with the ongoing rebuild.
      </p>
    </main>
  );
}
