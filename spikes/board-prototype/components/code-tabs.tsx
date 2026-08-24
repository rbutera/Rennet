"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import type { CodeAnchor, CodeExcerpt } from "@/lib/lens-data"
import { CodeBlock } from "@/components/code-block"

function tabLabel(path: string, line: number) {
  return `${path.split("/").pop()}:${line}`
}

/** Quiet pill tabs shared by the excerpt viewer and click-to-reveal anchors. */
function TabPill({
  label,
  active,
  title,
  onClick,
}: {
  label: string
  active: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-[12px] transition-colors",
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
      )}
    >
      {label}
    </button>
  )
}

/**
 * Tabbed code viewer: one tab per excerpt, one visible code block card. Used
 * by elements that cite several places at once (a decision's evidence) so the
 * reader jumps between them without stacked blocks.
 */
export function CodeTabs({ excerpts }: { excerpts: CodeExcerpt[] }) {
  const [active, setActive] = React.useState(0)
  const excerpt = excerpts[active]
  if (!excerpt) return null

  return (
    <div className="flex flex-col gap-1.5">
      {excerpts.length > 1 && (
        <div role="tablist" className="flex flex-wrap items-center gap-1">
          {excerpts.map((tab, index) => (
            <TabPill
              key={`${tab.path}:${tab.startLine}`}
              label={tabLabel(tab.path, tab.startLine)}
              active={index === active}
              title={tab.path}
              onClick={() => setActive(index)}
            />
          ))}
        </div>
      )}
      <CodeBlock
        code={excerpt.code}
        path={excerpt.path}
        lang={excerpt.lang}
        startLine={excerpt.startLine}
        highlightLines={excerpt.highlightLines}
      />
    </div>
  )
}

type FetchedSlice = { code: string; startLine: number }

/**
 * Click-to-reveal code refs: a row of path:line chips; clicking one fetches
 * the real lines around the cited line (via /api/source) and shows them in a
 * code block card below. Clicking the active chip folds the card away.
 */
export function AnchorReveal({ anchors }: { anchors: CodeAnchor[] }) {
  const [active, setActive] = React.useState<number | null>(null)
  const [slices, setSlices] = React.useState<Record<string, FetchedSlice | "error">>({})

  const key = (anchor: CodeAnchor) => `${anchor.path}:${anchor.line}`

  async function toggle(index: number) {
    if (active === index) {
      setActive(null)
      return
    }
    setActive(index)
    const anchor = anchors[index]
    if (!anchor || slices[key(anchor)]) return
    try {
      const response = await fetch(
        `/api/source?path=${encodeURIComponent(anchor.path)}&line=${anchor.line}`,
      )
      const body = (await response.json()) as FetchedSlice & { error?: string }
      setSlices((previous) => ({
        ...previous,
        [key(anchor)]: response.ok ? { code: body.code, startLine: body.startLine } : "error",
      }))
    } catch {
      setSlices((previous) => ({ ...previous, [key(anchor)]: "error" }))
    }
  }

  const activeAnchor = active === null ? undefined : anchors[active]
  const activeSlice = activeAnchor ? slices[key(activeAnchor)] : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {anchors.map((anchor, index) => (
          <button
            key={key(anchor)}
            type="button"
            title={active === index ? "Hide code" : `Show ${anchor.path}:${anchor.line}`}
            onClick={() => toggle(index)}
            className={cn(
              "w-fit rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
              active === index
                ? "border-border bg-secondary text-foreground"
                : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {tabLabel(anchor.path, anchor.line)}
          </button>
        ))}
      </div>
      {activeAnchor && activeSlice === undefined && (
        <p className="text-[12px] text-muted-foreground">Loading {tabLabel(activeAnchor.path, activeAnchor.line)}…</p>
      )}
      {activeAnchor && activeSlice === "error" && (
        <p className="text-[12px] text-muted-foreground">
          {activeAnchor.path} is not readable from this checkout.
        </p>
      )}
      {activeAnchor && activeSlice && activeSlice !== "error" && (
        <CodeBlock
          code={activeSlice.code}
          path={activeAnchor.path}
          startLine={activeSlice.startLine}
          highlightLines={[activeAnchor.line]}
        />
      )}
    </div>
  )
}
