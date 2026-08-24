"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import type { CodeExcerpt } from "@/lib/lens-data"
import { CodeBlock } from "@/components/code-block"

/**
 * Tabbed code viewer: one tab per excerpt, one visible code block card. Used
 * by elements that cite several places at once (a decision's evidence, a
 * finding's sites) so the reader jumps between them without stacked blocks.
 */
export function CodeTabs({ excerpts }: { excerpts: CodeExcerpt[] }) {
  const [active, setActive] = React.useState(0)
  const excerpt = excerpts[active]

  if (!excerpt) return null
  if (excerpts.length === 1) {
    return (
      <CodeBlock
        code={excerpt.code}
        path={excerpt.path}
        lang={excerpt.lang}
        startLine={excerpt.startLine}
        highlightLines={excerpt.highlightLines}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <div role="tablist" className="flex flex-wrap items-center gap-1">
        {excerpts.map((tab, index) => {
          const label = `${tab.path.split("/").pop()}:${tab.startLine}`
          return (
            <button
              key={`${tab.path}:${tab.startLine}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              title={tab.path}
              onClick={() => setActive(index)}
              className={cn(
                "rounded-t-md border border-b-0 px-2 py-1 font-mono text-[11px] transition-colors",
                index === active
                  ? "border-border bg-secondary/50 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
      <CodeBlock
        code={excerpt.code}
        path={excerpt.path}
        lang={excerpt.lang}
        startLine={excerpt.startLine}
        highlightLines={excerpt.highlightLines}
        className="rounded-tl-none"
      />
    </div>
  )
}
