"use client"

import { cn } from "@/lib/utils"
import { TARGET_LABEL, type TargetKind } from "@/lib/target-language"

export type TargetState = "needs-you" | "merged" | "reviewed"

/**
 * The one chip that names a review target, shared by the sidebar, the New
 * chat list, and session headers — the unified vocabulary (CONTEXT.md
 * "Session targets") rendered one way everywhere. A state outranks the plain
 * kind label: "Needs you" is the loudest thing on any surface it appears on.
 */
export function TargetBadge({
  kind,
  state,
  size = "md",
}: {
  kind: TargetKind
  state?: TargetState
  size?: "sm" | "md"
}) {
  const sizing =
    size === "sm" ? "px-1.5 py-px text-[9.5px]" : "px-2 py-0.5 text-[10.5px]"

  if (state === "needs-you") {
    return (
      <span className={cn("rounded-full bg-primary font-semibold text-primary-foreground", sizing)}>
        Needs you
      </span>
    )
  }
  if (state === "merged") {
    return (
      <span className={cn("rounded-full border border-border font-medium text-muted-foreground", sizing)}>
        Merged
      </span>
    )
  }
  if (state === "reviewed") {
    return (
      <span className={cn("rounded-full border border-green-500/30 bg-green-500/10 font-medium text-green-500", sizing)}>
        Reviewed
      </span>
    )
  }

  return (
    <span
      className={cn(
        "rounded-full font-medium",
        kind === "your-pr" && "border border-primary/50 text-primary",
        kind === "teammate-pr" && "border border-border bg-secondary/60 text-foreground/70",
        kind === "your-branch" && "border border-border bg-secondary/60 text-foreground/70",
        sizing,
      )}
    >
      {TARGET_LABEL[kind]}
    </span>
  )
}
