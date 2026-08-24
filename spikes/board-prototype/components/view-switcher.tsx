"use client"

import { cn } from "@/lib/utils"

export function ViewSwitcher({
  segments,
  active,
  onChange,
}: {
  segments: string[]
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
        const isActive = segment === active
        return (
          <button
            key={segment}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(segment)}
            className={cn(
              "whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors",
              isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {segment}
          </button>
        )
      })}
    </div>
  )
}
