import { Button, cn } from "@rennet/ui";
import { ArrowRight, GitPullRequest } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCoachAnchor, useMergedRefs } from "../coach/registry";
import { useRennetStore } from "../store";
import { type EntryMode, modeHasExits } from "./handoff-data";
import { selectExitPipCount } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The exit FAB (C08 cluster 2, Objective clause 1, autopsy S8) — the gold pill floating
// action button that toggles the hand-off view and carries the live exit count.
//
// THE AUTOPSY INVERSION (S8): the spike accumulated the pip count from a module-global
// event bus, so a fresh mount / a second surface / a projected client lost it and it drifted
// from the review. Here the count is `selectExitPipCount` DERIVED from the `review` slice —
// it reads the same after any navigation because nothing stores it, and opening the hand-off
// never clears it. The flight/pop is a separate axis: it rides the `signal` slice's
// `launch`/`land` (a gesture), never the count, so route transitions and scenario seeding —
// which move the count without a launch — never animate.
// ─────────────────────────────────────────────────────────────────────────────

const FLIGHT_MS = 420;
const POP_MS = 280;
/** Below 54rem of PANE width the label drops to icon + count (Objective clause 1). */
const COMPACT_BELOW_PX = 864;

export interface ExitFabProps {
  /** The review's entry mode — drives the target-aware label; retrospective renders nothing. */
  readonly mode: EntryMode;
  /** Whether the hand-off view is open — the FAB YIELDS (shrink/fade/inert) while it is (R49). */
  readonly open: boolean;
  /** Toggle the hand-off view. */
  readonly onToggle: () => void;
}

/**
 * Fly a red bubble from the focus-recovered acting element to the FAB when a gesture launches
 * (Objective clause 1, R50). The acting element is recovered from `document.activeElement`
 * (never wired per call site); with no source, or with no Web Animations API (SSR / older
 * happy-dom), the pip lands at once so the pop still fires. On finish the flight `land`s the
 * in-flight pips — the pop rides that landing.
 */
function useExitFlight(fabRef: React.RefObject<HTMLButtonElement | null>) {
  const inFlight = useRennetStore((s) => s.signal.inFlight);
  const land = useRennetStore((s) => s.signalActions.land);
  const prev = useRef(inFlight);

  useEffect(() => {
    const delta = inFlight - prev.current;
    prev.current = inFlight;
    if (delta <= 0) return; // a land (inFlight falling) or a static re-render never flies

    const fab = fabRef.current;
    const source =
      document.activeElement instanceof HTMLElement && document.activeElement !== fab
        ? document.activeElement
        : null;
    if (!fab || !source || typeof fab.animate !== "function") {
      land(delta);
      return;
    }

    const from = source.getBoundingClientRect();
    const to = fab.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "pointer-events-none fixed z-50 size-3 rounded-full bg-destructive";
    dot.style.left = `${from.left + from.width / 2 - 6}px`;
    dot.style.top = `${from.top + from.height / 2 - 6}px`;
    document.body.appendChild(dot);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const flight = dot.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 0.9 },
        {
          transform: `translate(${dx * 0.6}px, ${dy * 0.55}px) scale(1.25)`,
          opacity: 1,
          offset: 0.6,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.7 },
      ],
      { duration: FLIGHT_MS, easing: "cubic-bezier(0.3,0.6,0.3,1)" },
    );
    let landed = false;
    const finish = () => {
      if (landed) return;
      landed = true;
      dot.remove();
      land(delta);
    };
    flight.onfinish = finish;
    flight.oncancel = finish;
  }, [inFlight, land, fabRef]);
}

export function ExitFab({ mode, open, onToggle }: ExitFabProps) {
  const count = useRennetStore(selectExitPipCount);
  const landedTotal = useRennetStore((s) => s.signal.landed);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const pipRef = useRef<HTMLSpanElement | null>(null);
  // The `fab` coach mark anchors this button. Merge with `fabRef` — the exit-flight effect
  // reads `fabRef.current` for the pip landing geometry, so both must ride the one element.
  const fabAnchorRef = useMergedRefs<HTMLButtonElement>(fabRef, useCoachAnchor("fab"));

  useExitFlight(fabRef);

  // The pop rides the GESTURE (a land), never the count: a static re-render or a seeded stage
  // (count up, no land) leaves `landed` unchanged and does not pop.
  const [pop, setPop] = useState(false);
  const prevLanded = useRef(landedTotal);
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (landedTotal <= prevLanded.current) {
      prevLanded.current = landedTotal;
      return;
    }
    prevLanded.current = landedTotal;
    setPop(true);
    pipRef.current?.animate?.(
      [{ transform: "scale(0.6)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }],
      { duration: POP_MS, easing: "cubic-bezier(0.2,0.9,0.3,1)" },
    );
    if (popTimer.current) clearTimeout(popTimer.current);
    popTimer.current = setTimeout(() => setPop(false), POP_MS);
  }, [landedTotal]);
  useEffect(
    () => () => {
      if (popTimer.current) clearTimeout(popTimer.current);
    },
    [],
  );

  // Responsive: the root fills its positioned ancestor (the pane), so its width IS the pane's.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setCompact(width < COMPACT_BELOW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A retrospective review offers no exit (law 10) — the FAB does not exist for it.
  if (!modeHasExits(mode)) return null;

  const label = mode === "teammate-pr" ? "Write Review" : "Continue";
  const Icon = mode === "teammate-pr" ? GitPullRequest : ArrowRight;
  // The accessible name carries the count (R50 second amendment — no inline "· n" in the text).
  const accessibleName = count > 0 ? `${label}, ${count} staged` : label;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-40">
      <Button
        ref={fabAnchorRef}
        variant="default"
        onClick={onToggle}
        aria-label={accessibleName}
        aria-pressed={open}
        data-open={open || undefined}
        className={cn(
          "pointer-events-auto absolute right-6 bottom-6 h-12 gap-2 rounded-full px-5 shadow-lg",
          open && "pointer-events-none scale-90 opacity-0",
        )}
      >
        <Icon aria-hidden="true" />
        {compact ? null : <span>{label}</span>}
        {count > 0 && (
          <span
            ref={pipRef}
            data-pip="exit"
            data-pop={pop || undefined}
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-destructive-foreground"
          >
            {count}
          </span>
        )}
      </Button>
    </div>
  );
}
