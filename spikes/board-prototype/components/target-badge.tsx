"use client"

import {
  Check,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { TARGET_LABEL, type TargetKind } from "@/lib/target-language"

export type TargetState = "needs-you" | "merged" | "reviewed"

/**
 * The unified icon language for review targets (CONTEXT.md "Session targets"):
 * branch = your branch, pull-request = your PR, pull-request-arrow (incoming)
 * = teammate PR; merged uses the merge glyph, reviewed is a green tick, and
 * "needs you" is the accent color on the target's own icon.
 */
export const TARGET_ICON: Record<TargetKind, LucideIcon> = {
  "your-branch": GitBranch,
  "your-pr": GitPullRequest,
  "teammate-pr": GitPullRequestArrow,
}

function iconFor(kind: TargetKind, state?: TargetState): { Icon: LucideIcon; className: string; label: string } {
  if (state === "merged") {
    return { Icon: GitMerge, className: "text-muted-foreground", label: "Merged" }
  }
  if (state === "reviewed") {
    return { Icon: Check, className: "text-green-500", label: "Reviewed" }
  }
  const Icon = TARGET_ICON[kind]
  if (state === "needs-you") {
    return { Icon, className: "text-primary", label: `${TARGET_LABEL[kind]} — needs you` }
  }
  return { Icon, className: "text-muted-foreground", label: TARGET_LABEL[kind] }
}

/** Icon-only rendering: the sidebar's compact form. Tooltip carries the words. */
export function TargetIcon({
  kind,
  state,
  className,
}: {
  kind: TargetKind
  state?: TargetState
  className?: string
}) {
  const { Icon, className: tone, label } = iconFor(kind, state)
  return (
    <span title={label} className="flex shrink-0 items-center">
      <Icon className={cn("size-3.5", tone, className)} aria-label={label} />
    </span>
  )
}

/** Icon + text pill: the New chat list and session-header form. */
export function TargetBadge({
  kind,
  state,
  size = "md",
}: {
  kind: TargetKind
  state?: TargetState
  size?: "sm" | "md"
}) {
  const sizing = size === "sm" ? "px-1.5 py-px text-[9.5px]" : "px-2 py-0.5 text-[10.5px]"
  const iconSize = size === "sm" ? "size-2.5" : "size-3"

  if (state === "needs-you") {
    return (
      <span className={cn("flex items-center gap-1 rounded-full bg-primary font-semibold text-primary-foreground", sizing)}>
        <GitPullRequestArrow className={iconSize} aria-hidden="true" />
        Needs you
      </span>
    )
  }
  if (state === "merged") {
    return (
      <span className={cn("flex items-center gap-1 rounded-full border border-border font-medium text-muted-foreground", sizing)}>
        <GitMerge className={iconSize} aria-hidden="true" />
        Merged
      </span>
    )
  }
  if (state === "reviewed") {
    return (
      <span className={cn("flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 font-medium text-green-500", sizing)}>
        <Check className={iconSize} aria-hidden="true" />
        Reviewed
      </span>
    )
  }

  const Icon = TARGET_ICON[kind]
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full font-medium",
        kind === "your-pr" && "border border-primary/50 text-primary",
        kind === "teammate-pr" && "border border-border bg-secondary/60 text-foreground/70",
        kind === "your-branch" && "border border-border bg-secondary/60 text-foreground/70",
        sizing,
      )}
    >
      <Icon className={iconSize} aria-hidden="true" />
      {TARGET_LABEL[kind]}
    </span>
  )
}
