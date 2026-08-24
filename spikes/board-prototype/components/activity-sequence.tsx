"use client"

import { useCallback, useRef } from "react"
import { ThoughtBlock } from "@/components/thought-block"
import { ActionStep } from "@/components/action-step"
import type { ActivityStep } from "@/lib/conversation-data"

export function ActivitySequence({
  steps,
  onComplete,
}: {
  steps: ActivityStep[]
  onComplete?: () => void
}) {
  const resolvedIds = useRef(new Set<string>())
  const firedComplete = useRef(false)

  const handleResolve = useCallback(
    (id: string) => {
      resolvedIds.current.add(id)
      if (!firedComplete.current && resolvedIds.current.size === steps.length) {
        firedComplete.current = true
        onComplete?.()
      }
    },
    [steps.length, onComplete],
  )

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {steps.map((step) =>
        step.kind === "thought" ? (
          <ThoughtBlock key={step.id} step={step} onResolve={() => handleResolve(step.id)} />
        ) : (
          <ActionStep key={step.id} step={step} onResolve={() => handleResolve(step.id)} />
        ),
      )}
    </div>
  )
}
