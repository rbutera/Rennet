import type { LensKind } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import {
  DraftingCompass,
  Flag,
  GitCommitHorizontal,
  ListOrdered,
  type LucideIcon,
  VolumeX,
} from "lucide-react";
import { useCoachAnchor } from "../coach/registry";
import { Icon } from "../components/icon";
import { useRennetStore } from "../store";
import type { LensBoardEntry } from "./board-data";
import { deltaKey } from "./viewed-delta";

// ─────────────────────────────────────────────────────────────────────────────
// The lens switcher (C05 6.2, Objective clause 7) — a segmented control, one
// segment per lens that produced a terminal result this generation. `lenses` is already
// resolved through the board-data seam (the top bar calls `useLensBoards`): a durable
// failure or typed empty result remains selectable so its reason is reachable, while a
// lens with no terminal result simply is not in the list (never a disabled segment).
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

const LENS_ICON: Readonly<Record<LensKind, LucideIcon>> = {
  design: DraftingCompass,
  sequence: ListOrdered,
  decisions: GitCommitHorizontal,
  flagged: Flag,
  noise: VolumeX,
};

export function LensSwitcher({
  lenses,
  selected,
  onSelect,
  flaggedOpenCount = 0,
  className,
}: {
  readonly lenses: readonly LensBoardEntry[];
  readonly selected: LensKind | null;
  readonly onSelect: (lens: LensKind) => void;
  /** Open findings derived from immutable board bytes plus durable reviewer actions. */
  readonly flaggedOpenCount?: number;
  readonly className?: string;
}) {
  const viewed = useRennetStore((s) => s.viewedDelta.viewedDeltaSections);
  // The `lenses` coach mark anchors the switcher — registered inside the visible-guard so
  // the mark only elects when there is a switcher on screen (no lens boards ⇒ no anchor).
  const lensesRef = useCoachAnchor("lenses");
  if (lenses.length === 0) return null;

  return (
    <div
      ref={lensesRef}
      role="tablist"
      aria-label="Lens"
      data-kind="lens-switcher"
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-border bg-card/40 p-1",
        className,
      )}
    >
      {lenses.map(({ lens, board, failure, absence }) => {
        const unviewedDeltas =
          board?.sections.filter(
            (s) => s.delta !== undefined && !viewed[deltaKey(board.boardId, s.ref)],
          ).length ?? 0;
        const openCount = lens === "flagged" ? flaggedOpenCount : 0;
        const accessibleStatus =
          failure !== undefined
            ? ", failed to generate"
            : absence !== undefined
              ? `, ${absenceAccessibleStatus(absence)}`
              : lens === "flagged"
                ? `, ${openCount} open${openCount === 0 && unviewedDeltas > 0 ? ", changed this round" : ""}`
                : unviewedDeltas > 0
                  ? ", changed this round"
                  : "";
        const active = lens === selected;
        return (
          <button
            key={lens}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`${LENS_LABEL[lens]}${accessibleStatus}`}
            title={LENS_LABEL[lens]}
            data-lens={lens}
            data-failed={failure === undefined ? undefined : "true"}
            data-absent={absence === undefined ? undefined : absence}
            onClick={() => onSelect(lens)}
            className={cn(
              "relative flex items-center gap-2 whitespace-nowrap rounded-md px-3.5 py-2 font-medium text-13 transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="relative flex shrink-0">
              <Icon icon={LENS_ICON[lens]} className="size-4" />
              {openCount > 0 ? (
                <span
                  data-testid="lens-open-count"
                  aria-hidden="true"
                  className="-right-2 -top-2 absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 font-semibold text-10 text-destructive-foreground leading-none"
                >
                  {openCount}
                </span>
              ) : unviewedDeltas > 0 ? (
                <span
                  data-testid="lens-delta-pip"
                  data-delta-count={unviewedDeltas}
                  aria-hidden="true"
                  className="-right-1 -top-1 absolute size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </span>
            <span className="hidden @[46rem]:inline">{LENS_LABEL[lens]}</span>
          </button>
        );
      })}
    </div>
  );
}

function absenceAccessibleStatus(reason: NonNullable<LensBoardEntry["absence"]>): string {
  switch (reason) {
    case "no-material":
      return "no applicable specification found";
    case "no-decisions":
      return "no material decisions found";
    case "no-findings":
      return "no review findings found";
    case "no-noise":
      return "no safely skippable noise found";
  }
}
