import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/utils";

/** The close animation's length — must match the `duration-200` class below, because it
 *  is what decides when the children may leave the DOM. */
const CLOSE_MS = 200;

/**
 * A collapse primitive: grid-rows 0fr→1fr animates open/close of unknown-height
 * content with no measurement. Route every folding surface through this rather than
 * a conditional render, so the motion stays uniform.
 *
 * Children are MOUNTED ONLY WHILE VISIBLE (perf audit 2026-08-31 §5 H2: a ~700-claim
 * board kept every element in the DOM regardless of fold, so folding saved nothing).
 * The mount straddles the animation in both directions: opening mounts during the same
 * render that flips the row track, so the first frame of the transition already measures
 * real content; closing keeps the children for `CLOSE_MS` so the collapse animates over
 * them instead of snapping shut on an empty box. `inert` still takes the closing content
 * out of the tab order for that window.
 *
 * Under `prefers-reduced-motion` the track snaps (`transition-none`) while the unmount
 * still waits out `CLOSE_MS`; the content is already clipped to zero height by then, so
 * the delay is invisible — it costs a fold's worth of nodes for a fifth of a second.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(open);
  // Set during render, not in an effect: the children must land in the SAME commit that
  // sets `grid-rows-[1fr]`, or the open transition spends its first frame on an empty box.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <div
      data-slot="collapse"
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden" inert={!open}>
        {mounted ? children : null}
      </div>
    </div>
  );
}
