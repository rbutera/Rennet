"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { onFabSignal } from "@/lib/fab-signal"

/**
 * The FAB's notification pip + the flying bubble (R50, simplified): staging
 * anything into the review flies a bubble from the acting element to the FAB;
 * the pip itself is one red counter derived from review content (asks +
 * comments + threads), so it is durable — undo decrements it, nothing clears
 * it while the work is staged. Mount once inside the FAB; `fabRef` is the
 * flight destination.
 */
export function FabPips({
  fabRef,
  count,
}: {
  fabRef: React.RefObject<HTMLElement | null>
  count: number
}) {
  React.useEffect(() => {
    return onFabSignal((_register, source, delta) => {
      const fab = fabRef.current
      if (!source || !fab || delta <= 0) return
      const from = source.getBoundingClientRect()
      const to = fab.getBoundingClientRect()
      const dot = document.createElement("span")
      dot.className = "pointer-events-none fixed z-50 size-3 rounded-full bg-destructive"
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
      flight.onfinish = () => dot.remove()
    })
  }, [fabRef])

  // Animate only a fresh addition while mounted — a remount (view switch)
  // renders the pip statically, it is not news.
  const prevCount = React.useRef(count)
  const [pop, setPop] = React.useState(false)
  React.useEffect(() => {
    if (count > prevCount.current) {
      setPop(true)
      const timer = setTimeout(() => setPop(false), 280)
      prevCount.current = count
      return () => clearTimeout(timer)
    }
    prevCount.current = count
  }, [count])

  if (count === 0) return null

  return (
    <span
      className={cn(
        "absolute -right-1 -top-1.5 flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11.5px] font-semibold leading-none text-white shadow-sm",
        pop && "animate-pip-in",
      )}
      aria-hidden="true"
    >
      {count}
    </span>
  )
}
