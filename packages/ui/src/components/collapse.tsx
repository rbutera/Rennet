import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * The one collapse primitive (R47): grid-rows 0fr→1fr animates open/close of
 * unknown-height content with no measurement. Content stays mounted — `inert`
 * keeps the closed state out of the tab order. Every folding surface (lens
 * sections, sidebar groups, diff cards, thoughts) goes through this rather
 * than a conditional render, so the motion is uniform.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
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
        {children}
      </div>
    </div>
  );
}
