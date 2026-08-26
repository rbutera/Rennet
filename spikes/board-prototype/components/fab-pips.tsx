"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { onFabSignal, type PipRegister } from "@/lib/fab-signal"

const PIP_STYLE: Record<PipRegister, string> = {
  // Register colors (globals.css color roles): copper = requested changes,
  // green = the reviewer's evidence/comments, verdigris = the machine's adds.
  change: "bg-warn text-background",
  comment: "bg-green text-background",
  model: "bg-model text-background",
}

const PIP_DOT: Record<PipRegister, string> = {
  change: "bg-warn",
  comment: "bg-green",
  model: "bg-model",
}

/**
 * The FAB's notification pips + the flying bubble (R50). Mount once inside
 * the FAB button; `fabRef` is the flight destination. Staged work flies in
 * from the element that staged it and lands as a colored count pip; counts
 * clear when the reviewer opens the hand-off (they've seen the draft).
 */
export function FabPips({
  fabRef,
  clearSignal,
}: {
  fabRef: React.RefObject<HTMLElement | null>
  /** Bump to clear all pips (the hand-off view was opened). */
  clearSignal: number
}) {
  const [counts, setCounts] = React.useState<Record<PipRegister, number>>({
    change: 0,
    comment: 0,
    model: 0,
  })

  React.useEffect(() => {
    setCounts({ change: 0, comment: 0, model: 0 })
  }, [clearSignal])

  React.useEffect(() => {
    return onFabSignal((register, source, delta) => {
      const land = () =>
        setCounts((prev) => ({ ...prev, [register]: Math.max(0, prev[register] + delta) }))
      const fab = fabRef.current
      if (!source || !fab || delta <= 0) {
        land()
        return
      }
      // Fly a bubble from the acting element to the FAB, then land the count.
      const from = source.getBoundingClientRect()
      const to = fab.getBoundingClientRect()
      const dot = document.createElement("span")
      dot.className = cn("pointer-events-none fixed z-50 size-3 rounded-full", PIP_DOT[register])
      dot.style.left = `${from.left + from.width / 2 - 6}px`
      dot.style.top = `${from.top + from.height / 2 - 6}px`
      document.body.appendChild(dot)
      const dx = to.left + to.width - 10 - (from.left + from.width / 2)
      const dy = to.top - (from.top + from.height / 2)
      const flight = dot.animate(
        [
          { transform: "translate(0, 0) scale(1)", opacity: 0.9 },
          { transform: `translate(${dx * 0.6}px, ${dy * 0.55}px) scale(1.25)`, opacity: 1, offset: 0.6 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.7 },
        ],
        { duration: 420, easing: "cubic-bezier(0.3, 0.6, 0.3, 1)" },
      )
      flight.onfinish = () => {
        dot.remove()
        land()
      }
    })
  }, [fabRef])

  const shown = (Object.entries(counts) as [PipRegister, number][]).filter(([, n]) => n > 0)
  if (shown.length === 0) return null

  return (
    <span className="absolute -right-1 -top-1.5 flex gap-0.5" aria-hidden="true">
      {shown.map(([register, count]) => (
        <span
          key={register}
          className={cn(
            "flex h-4.5 min-w-4.5 animate-pip-in items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none shadow-sm",
            PIP_STYLE[register],
          )}
        >
          {count}
        </span>
      ))}
    </span>
  )
}
