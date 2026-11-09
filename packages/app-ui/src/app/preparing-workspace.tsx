import type { LensKind } from "@rennet/protocol";
import { useSearch } from "wouter";
import { LensBoardView } from "../board";
import { WorkspaceHeader } from "../board/workspace-header";
import { presenceShows, usePreparationPhase } from "../preparation/preparation-phase";
import { PreparationPresence } from "../preparation/preparation-presence";
import { readSessionQuery } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// THE WORKSPACE BEFORE THE REVIEW EXISTS (lens-board-tools 5.2, D12; review-preparation-
// reliability D6).
//
// While capture runs there is no review id yet, so `board.read` has nothing to ask for.
// That is not a reason to show a different screen, and it is not a reason to show an empty
// one either: an empty board view saying "No board for this generation yet." is what made a
// pull request that had just been opened look broken (Rai: "it didn't look like it was
// working at all"). So the board area is the preparation presence — a board-shaped skeleton
// with a slow sweep, under a rail that breathes with it, and Cancel inline.
//
// When the run stops before a review exists, the header carries the failure block and the
// board area stays empty: there is nothing to read, and the block owns the message.
//
// The same board view is still the fallback for any other phase, so a review that resolves
// a beat after its lanes open keeps rendering through the one component.
// ─────────────────────────────────────────────────────────────────────────────

export function PreparingWorkspace({ slug }: { readonly slug: string }) {
  const query = readSessionQuery(new URLSearchParams(useSearch()));
  const lens: LensKind = query.lens;
  const phase = usePreparationPhase(slug);
  const stopped = phase === "failed" || phase === "cancelled";
  return (
    <div className="rennet-workspace relative flex h-full min-h-0 flex-col">
      <WorkspaceHeader slug={slug} />
      <div data-region="board" className="flex min-h-0 flex-1 @container">
        <div className="chrome-scroll-clearance min-h-0 min-w-0 flex-1 overflow-y-auto">
          {presenceShows(phase) ? (
            <PreparationPresence slug={slug} />
          ) : stopped ? null : (
            <LensBoardView slug={slug} reviewId="" generation="" lens={lens} />
          )}
        </div>
      </div>
    </div>
  );
}
