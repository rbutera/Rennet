"use client"

import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ViewSegment {
  label: string
  icon: LucideIcon
  /** Unread round-delta rollup: the board behind this segment has sections the
   * last round touched that the reviewer has not opened yet. */
  dot?: boolean
}

/**
 * The lens segmented control. Labels collapse to icons when the surface is
 * narrow (container query on the header) — mobile and split layouts get an
 * icon rail, wide layouts get icon + label.
 */
export function ViewSwitcher({
  segments,
  active,
  onChange,
}: {
  segments: ViewSegment[]
  active: string
  onChange: (segment: string) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Main surface view"
      className="flex items-center gap-0.5 rounded-lg border border-border bg-card/40 p-1"
    >
      {segments.map((segment) => {
        const isActive = segment.label === active
        const Icon = segment.icon
        return (
          <button
            key={segment.label}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={segment.label}
            title={segment.label}
            onClick={() => onChange(segment.label)}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap rounded-md px-3.5 py-2 text-[13px] font-medium transition-colors",
              isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="relative flex shrink-0">
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {segment.dot && (
                <span
                  className="absolute -right-1 -top-1 size-1.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="hidden @[46rem]:inline">{segment.label}</span>
            {segment.dot && <span className="sr-only">, changed this round</span>}
          </button>
        )
      })}
    </div>
  )
}
