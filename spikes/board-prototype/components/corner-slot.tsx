"use client"

import { PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * DEMO (throwaway): the "corner slot" titlebar exploration.
 *
 * One component = emulated macOS traffic lights + the sidebar toggle. The
 * leftmost pane owns it: sidebar header when expanded, a head strip above the
 * chat header when the sidebar is collapsed and chat is open, floating over
 * the main surface when both are collapsed.
 *
 * The lights are decorative — they stand in for the REAL OS lights (hiddenInset
 * puts them at left 20px, 12px circles, 8px gaps) so clearance can be judged.
 */
export function CornerSlot({
  sidebarOpen,
  onToggle,
  className,
  floating = false,
}: {
  sidebarOpen: boolean
  onToggle: () => void
  className?: string
  /** Floating variant: translucent chip over content instead of a bare strip. */
  floating?: boolean
}) {
  return (
    <div
      className={cn(
        // h-10 strip at the top of a pane + pl-5 puts the lights at x=20,
        // centre y=20 — where hiddenInset actually draws them.
        "flex h-10 shrink-0 items-center pl-5",
        // Floating: a 32px pill inset 4px keeps the lights on that exact mark.
        floating && "h-8 rounded-full border border-border/50 bg-background/70 pl-4 pr-1.5 backdrop-blur-md",
        className,
      )}
    >
      <span className="flex items-center gap-2" aria-hidden="true">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        className="ml-3 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <PanelLeft className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
