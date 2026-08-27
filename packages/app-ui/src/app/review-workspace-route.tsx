import type { Review } from "@rennet/protocol";
import { useSearch } from "wouter";
import { LensBoardView } from "../board";
import { DiffViewContainer } from "../review";
import { readSessionQuery } from "../routes/url";

// The review workspace route (B2 stub → Track C rebuild, #489). The canvas-era surface
// was deleted in the delete-first cutover; the Board rebuild restores it view-by-view
// over `?view`. C6 owns the `diff` branch; C5 owns the default: the lens board document —
// sections in reading order, the lens switcher, and (once a review has frozen
// predecessors) the generation switcher.
//
// The board arrives through `board/board-data.ts`'s seam. No board-fetch command is
// registered yet (Reconciliation 1 — that is B4/B10's job), so with no `BoardSource`
// wired the surface renders its honest empty state until B8 emits real boards; the seam
// then binds `useCommand` in the single gated swap (cluster 8). Generation identity is
// likewise the session projection's to supply (B4/B9): until then the route opens on the
// one knowable, live generation.
const LIVE_GENERATION = "live";

export function ReviewWorkspace({ review }: { review: Review }) {
  const view = readSessionQuery(new URLSearchParams(useSearch())).view;
  if (view === "diff") return <DiffViewContainer review={review} />;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-border border-b px-6 py-3">
        <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          REVIEW · {review.repositoryRoot.split("/").at(-1)}
        </p>
      </header>
      <LensBoardView generation={LIVE_GENERATION} />
    </div>
  );
}
