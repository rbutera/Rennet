"use client"

import { useEffect, useState } from "react"
import { Collapse } from "@/components/collapse"
import { Loader2, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ThoughtStep } from "@/lib/conversation-data"

export function ThoughtBlock({ step, onResolve }: { step: ThoughtStep; onResolve?: () => void }) {
  const isLive = step.state === "streaming"
  const [collapsed, setCollapsed] = useState(!isLive)
  const [visibleParagraphs, setVisibleParagraphs] = useState(isLive ? 0 : step.text.length)
  const [manuallyOpened, setManuallyOpened] = useState(false)

  useEffect(() => {
    if (!isLive) {
      onResolve?.()
      return
    }

    const timers: ReturnType<typeof setTimeout>[] = []
    for (let index = 1; index <= step.text.length; index++) {
      timers.push(
        setTimeout(() => {
          setVisibleParagraphs(index)
        }, 500 + (index - 1) * 900),
      )
    }
    timers.push(
      setTimeout(() => {
        setCollapsed(true)
        onResolve?.()
      }, 500 + step.text.length * 900 + 700),
    )

    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, step.text.length])

  const stillRevealing = isLive && visibleParagraphs < step.text.length
  const isExpanded = !collapsed || manuallyOpened
  const shownCount = collapsed ? (manuallyOpened ? step.text.length : 0) : visibleParagraphs

  return (
    <div className="max-w-[640px]">
      <button
        type="button"
        onClick={() => collapsed && setManuallyOpened((v) => !v)}
        className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground/80 hover:text-muted-foreground"
        aria-expanded={isExpanded}
      >
        <Loader2
          className={cn("size-3 shrink-0", stillRevealing ? "animate-spin text-model" : "text-muted-foreground/70")}
          aria-hidden="true"
        />
        <span>{collapsed ? `Thought for ${step.seconds ?? 1}s` : "Thinking"}</span>
        {collapsed && (
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", manuallyOpened && "rotate-90")}
            aria-hidden="true"
          />
        )}
      </button>
      <Collapse open={isExpanded && shownCount > 0}>
        <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3 font-prose text-[13px] italic leading-relaxed text-muted-foreground">
          {step.text.slice(0, shownCount).map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </Collapse>
    </div>
  )
}
