import { cn } from "@rennet/ui";

// ─────────────────────────────────────────────────────────────────────────────
// The generation switcher (C05 6.3, Objective clause 9) — drill from the current
// generation back to a frozen predecessor's boards. Generations are append-then-
// freeze (#457): the live board and its frozen ancestors. Selecting a frozen
// generation resolves that generation's boards through the same board-data seam
// (board-view passes the selected id straight to `useLensBoards`), so drill-down is
// just a different generation id — no second data path.
//
// A frozen generation reads read-only in the plain sense that it is a past round the
// reviewer is looking back at; there is nothing to disable and no gate (Rule Zero) —
// the label says `frozen`, the surface renders it the same way. With one generation
// there is nothing to drill into, so the control does not render.
// ─────────────────────────────────────────────────────────────────────────────

export function GenerationSwitcher({
  generations,
  selected,
  current,
  onSelect,
}: {
  /** All generation ids for this review, oldest → newest. */
  readonly generations: readonly string[];
  /** The generation currently on screen. */
  readonly selected: string;
  /** The live generation; every other id is a frozen predecessor. */
  readonly current: string;
  readonly onSelect: (generation: string) => void;
}) {
  if (generations.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Generation"
      data-kind="generation-switcher"
      className="flex gap-1"
    >
      {generations.map((generation, index) => {
        const active = generation === selected;
        const live = generation === current;
        return (
          <button
            key={generation}
            type="button"
            role="tab"
            aria-selected={active}
            data-generation={generation}
            data-frozen={live ? undefined : "true"}
            onClick={() => onSelect(generation)}
            className={cn(
              "rounded-md px-2.5 py-1 text-2xs transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
            )}
          >
            Generation {index + 1}
            <span className="ml-1.5 text-muted-foreground">{live ? "· live" : "· frozen"}</span>
          </button>
        );
      })}
    </div>
  );
}
