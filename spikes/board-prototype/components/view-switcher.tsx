"use client"

import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ViewSegment {
  label: string
  icon: LucideIcon
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
      className="flex items-center gap-0.5 rounded-md border border-border bg-card/40 p-0.5"
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
              "flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors",
              isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden @[46rem]:inline">{segment.label}</span>
          </button>
        )
      })}
    </div>
  )
}
