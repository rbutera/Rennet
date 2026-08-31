import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/utils";

/** The fold animation's length — must match the `duration-200` class below, because it
 *  is what decides when the children may leave the DOM. Exported because a caller that
 *  acts on the RESULT of a fold has to wait out the same window: `followBoardAnchor` in
 *  app-ui scrolls to a target whose section it just opened, and the grid track is still
 *  growing until this elapses. One constant, not two magic 200s. */
export const COLLAPSE_MS = 200;

/**
 * A collapse primitive: grid-rows 0fr→1fr animates open/close of unknown-height
 * content with no measurement. Route every folding surface through this rather than
 * a conditional render, so the motion stays uniform.
 *
 * Children are MOUNTED ONLY WHILE VISIBLE (perf audit 2026-08-31 §5 H2: a ~700-claim
 * board kept every element in the DOM regardless of fold, so folding saved nothing).
 * The mount straddles the animation in both directions: opening mounts during the same
 * render that flips the row track, so the first frame of the transition already measures
 * real content; closing keeps the children for `COLLAPSE_MS` so the collapse animates over
 * them instead of snapping shut on an empty box. `inert` still takes the closing content
 * out of the tab order for that window.
 *
 * Under `prefers-reduced-motion` the track snaps (`transition-none`) while the unmount
 * still waits out `COLLAPSE_MS`; the content is already clipped to zero height by then, so
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
    // `!mounted` is the ALREADY-CLOSED mount, and it is the common case: a ~700-claim board
    // mounts hundreds of folded sections at once, every one of which used to schedule a
    // timer whose only act was to set `false` on state that is already `false`. Nothing to
    // unmount means nothing to wait for.
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

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
