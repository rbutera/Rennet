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
import { lensSlot, lensTint } from "./lens-colour";
import { LENS_LABEL, type SeatCut, type SeatRegister, waitingOnLine } from "./lens-seats";
import { deltaKey } from "./viewed-delta";

// ─────────────────────────────────────────────────────────────────────────────
// The lens rail (C05 6.2, Objective clause 7; lens-board-tools 5.1/5.5/5.7) — a
// segmented control with one segment per lens, ALL FIVE, from the first frame of the
// generation. `lenses` is resolved through the board-data seam, which now carries each
// lens's seat state beside its board: the rail renders what it is given and decides
// nothing about which lenses exist.
//
// THE STOP IS THE STATE, IN SHAPE (5.5, D12). The bench's five core samples are gone and
// their register moved here, onto the stop this rail already drew — `lens-switcher.tsx`'s
// own comment called it "the same device the bench's core samples hang on, at rail scale",
// so the `data-cut` vocabulary rides it rather than being invented somewhere new:
//
//   unstarted  a faint rule: nothing has been drawn yet.
//   open       a dashed rule with a lamp travelling along it — the one moving thing on
//              the rail, and it means this seat is writing right now.
//   clean      a solid rule: the board is cut and it stops moving.
//   seamed     the same, split by a gap where the board was re-cut this generation.
//   snapped    two offset pieces: the seat broke before it settled.
//   empty      a dotted outline — the lens settled with nothing to draw.
//
// COLOUR IS IDENTITY, NEVER STATE. The hue says which lens this is (#818), so a failed
// Design lane is a snapped BLUE stop, never a red one, and every register above survives
// the colour being ignored entirely.
//
// Delta rollup (Objective clause 7 / #486): each segment carries a small gold pip counting
// the sections in that lens's board that carry a `new`/`reworked` delta and are still
// UNVIEWED — WITHHELD while the board is still being written (5.4/D13), because a partial
// board would mark every element new and a reviewer would act on the count.
// ─────────────────────────────────────────────────────────────────────────────

export { LENS_LABEL };

const LENS_ICON: Readonly<Record<LensKind, LucideIcon>> = {
  design: DraftingCompass,
  sequence: ListOrdered,
  decisions: GitCommitHorizontal,
  flagged: Flag,
  noise: VolumeX,
};

/** One lens's stop, cut the way its seat's register says. Lens-AGNOSTIC: it paints in
 *  `lens`/`lens-line`, which resolve against whatever `--rn-lens` the tab bound. */
function LensStop({ cut, active }: { readonly cut: SeatCut; readonly active: boolean }) {
  const ink = active ? "bg-lens" : "bg-lens-line";
  if (cut === "snapped") {
    // Two pieces, offset, with nothing between them — a break is a SHAPE, so it reads
    // with the colour turned off.
    return (
      <span
        data-testid="lens-stop"
        data-cut={cut}
        aria-hidden="true"
        className="absolute inset-x-2 bottom-1 flex h-1 items-start"
      >
        <span className={cn("h-0.5 w-1/3 rounded-full", ink)} />
        <span className="w-1/3" />
        <span className={cn("mt-0.5 h-0.5 w-1/3 self-end rounded-full", ink)} />
      </span>
    );
  }
  if (cut === "seamed") {
    return (
      <span
        data-testid="lens-stop"
        data-cut={cut}
        aria-hidden="true"
        className="absolute inset-x-2 bottom-1 flex h-0.5 gap-1"
      >
        <span className={cn("h-0.5 flex-1 rounded-full", ink)} />
        <span className={cn("h-0.5 flex-1 rounded-full", ink)} />
      </span>
    );
  }
  return (
    <span
      data-testid="lens-stop"
      data-cut={cut}
      aria-hidden="true"
      className={cn(
        "absolute inset-x-2 bottom-1 h-0.5 overflow-hidden rounded-full transition-colors",
        cut === "clean" && ink,
        cut === "unstarted" && "bg-lens-line/60",
        // A settled absence and an unstarted lane are both quiet, and they are quiet in
        // different SHAPES: dotted says "the socket was never filled", faint says "not yet".
        cut === "empty" &&
          "bg-[length:4px_2px] bg-[linear-gradient(to_right,var(--color-lens-line)_50%,transparent_50%)] bg-repeat-x",
        cut === "open" &&
          "bg-[length:4px_2px] bg-[linear-gradient(to_right,var(--color-lens)_50%,transparent_50%)] bg-repeat-x",
      )}
    >
      {cut === "open" && (
        // The affineur's lamp, at rail scale. `motion-reduce:hidden`, not `animate-none`:
        // parked at the left it is a static band that reads as a mark of its own, and the
        // dashed rule under it already says "under way".
        <span className="pointer-events-none block h-0.5 w-1/3 rounded-full bg-lens animate-lens-stop-scan motion-reduce:hidden" />
      )}
    </span>
  );
}

/** The per-voice working indicator: one ring per seat, so Flagged carries two. */
function SeatIndicators({
  register,
  voices,
}: {
  readonly register: SeatRegister;
  readonly voices: number;
}) {
  if (register !== "working") return null;
  return (
    <span data-testid="lens-working" data-voices={voices} className="flex shrink-0 items-center">
      {Array.from({ length: Math.max(1, voices) }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the voices are positional marks with no identity of their own beyond their count.
          key={index}
          aria-hidden="true"
          className="-ml-0.5 first:ml-0 size-1.5 rounded-full border border-lens animate-processing-pulse motion-reduce:animate-none"
        />
      ))}
    </span>
  );
}

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
      {lenses.map(({ lens, board, failure, absence, seat }) => {
        // Withheld while the board is still being written (5.4): a partial board would
        // mark every section new, which is a lie the reviewer would act on.
        const unviewedDeltas = seat.drafting
          ? 0
          : (board?.sections.filter(
              (s) => s.delta !== undefined && !viewed[deltaKey(board.boardId, s.ref)],
            ).length ?? 0);
        const openCount = lens === "flagged" && !seat.drafting ? flaggedOpenCount : 0;
        const waiting = seat.register === "waiting" ? waitingOnLine(seat.waitingOn) : "";
        const accessibleStatus =
          seat.register === "working"
            ? `, working${seat.voices.length > 1 ? `, ${seat.voices.length} voices` : ""}`
            : seat.register === "waiting"
              ? `, ${waiting}`
              : failure !== undefined
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
            title={
              seat.register === "waiting" && waiting
                ? `${LENS_LABEL[lens]} — ${waiting}`
                : LENS_LABEL[lens]
            }
            data-lens={lens}
            data-lens-slot={lensSlot(lens)}
            data-register={seat.register}
            data-failed={failure === undefined ? undefined : "true"}
            data-absent={absence === undefined ? undefined : absence}
            {...(seat.waitingOn.length > 0 ? { "data-waiting-on": seat.waitingOn.join(",") } : {})}
            onClick={() => onSelect(lens)}
            className={cn(
              // The tab binds its lens's hue for its own subtree; the stop and the
              // active glyph below paint in it without naming a lens.
              "relative flex items-center gap-2 whitespace-nowrap rounded-md px-3.5 pt-2 pb-2.5 font-medium text-13 transition-colors",
              lensTint(lens),
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LensStop cut={seat.cut} active={active} />
            <span className="relative flex shrink-0">
              <Icon icon={LENS_ICON[lens]} className={cn("size-4", active && "text-lens")} />
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
            <SeatIndicators register={seat.register} voices={seat.voices.length} />
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
    case "no-spec":
      return "no spec found for this branch";
    case "no-decisions":
      return "no material decisions found";
    case "no-findings":
      return "no review findings found";
    case "no-noise":
      return "every region is on another board";
  }
}
