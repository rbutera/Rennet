import type { LensKind } from "@rennet/protocol";
import { useSearch } from "wouter";
import { LensBoardView } from "../board";
import { WorkspaceHeader } from "../board/workspace-header";
import { readSessionQuery } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// THE WORKSPACE BEFORE THE REVIEW EXISTS (lens-board-tools 5.2, D12).
//
// While capture runs there is no review id yet, so `board.read` has nothing to ask for.
// That is not a reason to show a different screen: it is the same board view, with the
// same rail above it, saying honestly that no board has arrived. The capture step is
// named in the workspace header over the boards, exactly as it is once the review exists.
//
// This replaces `preparation-bench.tsx`, which was a SEPARATE STAGE the boards later took
// over from. Its three parts each have a home now: the slab and the two-beat capture rail
// became `WorkspaceHeader`, the five readers became the rail's per-lens stops plus the
// seat widget above the selected board, and the boards it appended below itself are the
// workspace.
//
// The only thing it renders that the review workspace does not is nothing at all — every
// difference is the empty review id flowing through the same components.
// ─────────────────────────────────────────────────────────────────────────────

export function PreparingWorkspace({ slug }: { readonly slug: string }) {
  const query = readSessionQuery(new URLSearchParams(useSearch()));
  const lens: LensKind = query.lens;
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      <WorkspaceHeader slug={slug} />
      <div data-region="board" className="flex min-h-0 flex-1 @container">
        <div className="chrome-scroll-clearance min-h-0 min-w-0 flex-1 overflow-y-auto">
          {/* No review and no generation: every board read stays disabled and resolves
              honest-missing, and the lanes (empty, because the daemon has not opened one
              during capture) are what tell the rail this generation IS running. */}
          <LensBoardView slug={slug} reviewId="" generation="" lens={lens} />
        </div>
      </div>
    </div>
  );
}
