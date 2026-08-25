"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import type { ActionStep as ActionStepData } from "@/lib/conversation-data"

export function ActionStep({ step, onResolve }: { step: ActionStepData; onResolve?: () => void }) {
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (step.state !== "running") {
      onResolve?.()
      return
    }
    const timer = setTimeout(() => {
      setResolved(true)
      onResolve?.()
    }, 5000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.state])

  const isRunning = step.state === "running" && !resolved
  const Icon = step.icon
  const label = resolved && step.doneLabel ? step.doneLabel : step.label
  const detail = resolved && step.doneDetail !== undefined ? step.doneDetail : step.detail

  return (
    <div className="flex max-w-[640px] items-center gap-1.5 text-[12.5px]">
      <Icon
        className={cn("size-3 shrink-0", isRunning ? "animate-spin text-model" : "text-muted-foreground/70")}
        aria-hidden="true"
      />
      <span
        className={cn(
          "truncate underline decoration-dotted decoration-1 underline-offset-2",
          isRunning ? "text-foreground decoration-primary/50" : "text-muted-foreground decoration-border",
        )}
      >
        {label}
        {detail ? ` · ${detail}` : ""}
      </span>
      <span className="sr-only">{isRunning ? "running" : "done"}</span>
    </div>
  )
}
