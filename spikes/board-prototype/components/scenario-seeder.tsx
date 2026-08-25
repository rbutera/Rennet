"use client"

import * as React from "react"
import { useCodeComments } from "@/components/code-comments"
import type { Scenario } from "@/lib/scenarios"

/**
 * Seeds a scenario's pre-staged asks into the comment store on entry (R29),
 * so a scenario like `rounds` opens with its real findings already in the
 * basket. Runs inside the store provider; re-seeds only when the scenario
 * changes, clearing the prior scenario's asks first so the count can't drift.
 */
export function ScenarioSeeder({ scenario }: { scenario: Scenario }) {
  const store = useCodeComments()
  const seededFor = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!store || seededFor.current === scenario.id) return
    seededFor.current = scenario.id
    for (const ask of store.asks) store.unstageAsk(ask.id)
    for (const seed of scenario.seedAsks ?? []) {
      store.stageAsk(seed.text, seed.intent, seed.source, seed.codeAnchor)
    }
    // Only the scenario identity decides a reseed; store methods are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id])

  return null
}
