import type { LensSection } from "@rennet/protocol";
import { Collapse, cn } from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Icon } from "../components/icon";
import { useRennetStore } from "../store";
import { useBoardId, useElement } from "./kinds/element-context";
import { BoardChildren } from "./kinds/renderers";
import { selectDeltaViewed } from "./viewed-delta";

// ─────────────────────────────────────────────────────────────────────────────
// The fold grammar (C05 cluster 4, Objective clauses 2/3 + #486). A top-level
// `LensSection` renders on `packages/ui`'s `Collapse`: folded, it is the one-line
// `gist` plus its per-kind `counts`; unfolded, it is the referenced `section`
// element's children through the registry (`BoardChildren`). This is the SEPARATE
// fold component for the projection's section entries — distinct from the inline
// `kinds/section.tsx` renderer that keeps the element registry total.
//
// Disclosure pattern (the spike's): the heading IS the toggle; the children stay
// mounted (Collapse animates grid-rows, never a conditional render).
//
// Delta marks (#486): a section carrying `delta: "new" | "reworked"` opens EXPANDED
// and wears a transient gold dot (`bg-primary`) while unviewed; interacting (toggling
// the heading, or clicking the folded gist) marks it viewed through the UI-only
// `viewedDelta` slice, clearing the dot. Absence of a delta = carried-forward, no dot.
// ─────────────────────────────────────────────────────────────────────────────

const DELTA_LABEL: Record<"new" | "reworked", string> = {
  new: "new this round",
  reworked: "reworked this round",
};

/** The folded fold-line: the one-line gist plus per-kind count chips. */
function FoldLine({
  gist,
  counts,
}: {
  readonly gist: string;
  readonly counts: LensSection["counts"];
}) {
  const chips = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">{gist}</span>
      {chips.length > 0 && (
        <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {chips.map(([kind, n]) => (
            <span key={kind} className="rounded bg-secondary px-1.5 py-0.5">
              {kind} ×{n}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * Render one top-level board section. `entry` is the projection's fold-line; the
 * section element (`entry.ref`) is resolved through the board pool for its title and
 * children. `defaultOpen` lets board-view drive `foldAll` (R44); a delta section
 * defaults to open regardless.
 */
export function Section({
  entry,
  defaultOpen,
}: {
  readonly entry: LensSection;
  readonly defaultOpen?: boolean;
}) {
  const boardId = useBoardId();
  const el = useElement(entry.ref);
  const viewed = useRennetStore(selectDeltaViewed(boardId, entry.ref));
  const markViewed = useRennetStore((s) => s.viewedDeltaActions.markDeltaViewed);
  const [open, setOpen] = useState(defaultOpen ?? entry.delta !== undefined);

  // A dangling / non-section ref renders nothing (mirrors the pool's other resolvers).
  if (el?.kind !== "section") return null;
  const { title, children } = el.data;

  const showDot = entry.delta !== undefined && !viewed;
  const interact = () => {
    setOpen((o) => !o);
    if (entry.delta !== undefined) markViewed(boardId, entry.ref);
  };

  return (
    <section
      data-kind="board-section"
      data-section-id={entry.ref}
      {...(entry.delta ? { "data-delta": entry.delta } : {})}
      data-open={open}
      className="flex flex-col"
    >
      <button
        type="button"
        onClick={interact}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 py-1.5 text-left"
      >
        <Icon
          icon={ChevronDown}
          className={cn(
            "mt-1 size-3.5 shrink-0 self-start text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 font-semibold text-foreground text-sm">{title}</span>
        {showDot && (
          <span
            data-testid="delta-dot"
            className="mt-1.5 size-2 shrink-0 self-start rounded-full bg-primary"
          >
            <span className="sr-only">{DELTA_LABEL[entry.delta as "new" | "reworked"]}</span>
          </span>
        )}
      </button>
      {!open && (
        <button
          type="button"
          onClick={interact}
          className="flex w-full pb-1.5 pl-5 text-left"
          aria-hidden
          tabIndex={-1}
        >
          <FoldLine gist={entry.gist} counts={entry.counts} />
        </button>
      )}
      <Collapse open={open}>
        <div className="flex flex-col gap-3 pt-1 pb-2 pl-5">
          <BoardChildren ids={children} />
        </div>
      </Collapse>
    </section>
  );
}
