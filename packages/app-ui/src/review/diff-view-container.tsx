import type { Review } from "@rennet/protocol";
import { activePatchsetFiles } from "./diff-source";
import { DiffView } from "./diff-view";

// ─────────────────────────────────────────────────────────────────────────────
// The diff mount (C6, task 4.2). Reads the active patchset's changed files off the
// resolved review through the ONE projection seam (`diff-source.ts`) and renders the
// surface. An empty or absent patchset gets an honest one-line state — never a blank
// frame. The flex-column wrapper gives the surface (`flex flex-1`) its height inside the
// outlet's block cell.
// ─────────────────────────────────────────────────────────────────────────────

export function DiffViewContainer({ review }: { review: Review }) {
  const files = activePatchsetFiles(review);
  if (files.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center p-10 text-center font-serif text-ink-soft"
        role="status"
      >
        This patchset has no changed files to show.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiffView files={files} />
    </div>
  );
}
