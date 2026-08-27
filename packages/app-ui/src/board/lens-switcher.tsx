import type { LensKind } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { useRennetStore } from "../store";
import type { LensBoardEntry } from "./board-data";

// ─────────────────────────────────────────────────────────────────────────────
// The lens switcher (C05 6.2, Objective clause 7) — a segmented control, one
// segment per lens THAT HAS A BOARD this generation. `lenses` is already resolved
// through the board-data seam (board-view calls `useLensBoards`), so a lens with no
// board simply is not in the list: absent, NEVER a disabled segment (the packet's
// absent-not-disabled contract).
//
// Delta rollup (Objective clause 7 / #486): each segment carries a small gold pip
// counting the sections in that lens's board that carry a `new`/`reworked` delta and
// are still UNVIEWED. It is the section-level dot (`section.tsx`) rolled up — derived
// live from the SAME UI-only `viewedDelta` slice, never a stored count (store's
// DELETE-ON-SIGHT rule), so it clears as the reviewer reads those sections.
// ─────────────────────────────────────────────────────────────────────────────

/** Reader-facing lens names — the id vocabulary (`manifests/`) is lower-case. */
export const LENS_LABEL: Record<LensKind, string> = {
  design: "Design",
  sequence: "Sequence",
  decisions: "Decisions",
  flagged: "Flagged",
  noise: "Noise",
};

export function LensSwitcher({
  lenses,
  selected,
  onSelect,
}: {
  readonly lenses: readonly LensBoardEntry[];
  readonly selected: LensKind | null;
  readonly onSelect: (lens: LensKind) => void;
}) {
  const viewed = useRennetStore((s) => s.viewedDelta.viewedDeltaSections);
  if (lenses.length === 0) return null;

  return (
    <div role="tablist" aria-label="Lens" data-kind="lens-switcher" className="flex gap-1">
      {lenses.map(({ lens, board }) => {
        const unviewedDeltas = board.sections.filter(
          (s) => s.delta !== undefined && !viewed[s.ref],
        ).length;
        const active = lens === selected;
        return (
          <button
            key={lens}
            type="button"
            role="tab"
            aria-selected={active}
            data-lens={lens}
            onClick={() => onSelect(lens)}
            className={cn(
              "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
            )}
          >
            {LENS_LABEL[lens]}
            {unviewedDeltas > 0 && (
              <span
                data-testid="lens-delta-pip"
                data-delta-count={unviewedDeltas}
                className="size-2 shrink-0 rounded-full bg-primary"
              >
                <span className="sr-only">
                  {unviewedDeltas} section{unviewedDeltas === 1 ? "" : "s"} new or reworked this
                  round
                </span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
