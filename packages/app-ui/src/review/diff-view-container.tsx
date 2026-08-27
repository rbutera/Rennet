import type { Review } from "@rennet/protocol";
import { activePatchsetFiles } from "./diff-source";
import { DiffView } from "./diff-view";

// ─────────────────────────────────────────────────────────────────────────────
// The diff mount (C6, task 4.2). Reads the active patchset's changed files off the
// resolved review through the ONE projection seam (`diff-source.ts`) and renders the
// surface. An empty or absent patchset gets an honest one-line state — never a blank
// frame. The flex-column wrapper gives the surface (`flex flex-1`) its height inside the
// outlet's block cell.
//
// Round diff (finding 2): the rounds ledger links here with `?round=<generation>` to reach a
// PAST round's IMMUTABLE diff. Resolving a generation → its frozen patchset needs a per-round
// patchset projection that does NOT exist yet — the `Review` projection carries only
// `activePatchsetId` + the current `patchsets`, with no generation/commit-range key to select a
// frozen round's snapshot (a B9/B4 `RoundRecord.patchsetId` gap; see the C09 ledger). So rather
// than SILENTLY resolving to the latest patchset — the exact lie the finding names — a round
// request renders an honest "not wired yet" state until that field lands. The live diff
// (no `?round`) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export function DiffViewContainer({
  review,
  roundGeneration,
}: {
  review: Review;
  /** A past round's generation id (from the ledger's Round-diff link), or undefined for the
   *  live review diff. Present ⇒ the immutable round diff, pending the B9 patchset-per-round
   *  projection — surfaced honestly, never silently swapped for the latest patchset. */
  roundGeneration?: string;
}) {
  if (roundGeneration !== undefined) {
    return (
      <div
        data-testid="round-diff-pending"
        data-round-generation={roundGeneration}
        className="flex h-full items-center justify-center p-10 text-center font-serif text-ink-soft"
        role="status"
      >
        This round's immutable diff isn't wired yet — it needs the per-round patchset the round
        engine will pin (B9). Until then, only the live review diff is available.
      </div>
    );
  }
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
