import type { LensBoard, LensId } from "@/lib/lens-data"
import type { SessionItem } from "@/lib/sidebar-data"
import type { TurnData } from "@/lib/conversation-data"

/**
 * The demo-scenario registry — the named workflows Rai and agents both know
 * (see SCENARIOS.md for the roster and authority). A sidebar session row maps
 * 1:1 to a scenario; clicking it IS the scenario switch. This is a registry of
 * fixtures, not a session engine.
 */
export type ScenarioId = "teammate" | "rounds" | "returned" | "propose"

export interface AskSeed {
  text: string
  intent: "comment" | "request-change"
  source: string
  codeAnchor?: { path: string; line: number }
}

export interface Scenario {
  id: ScenarioId
  projectId: string
  /** The sidebar row — derived into sidebar-data so the 1:1 mapping cannot drift. */
  session: SessionItem
  cta: "Write Review" | "Continue"
  transcript: TurnData[]
  /** Absent lens = absent view-switcher segment (never a disabled one). */
  boards: Partial<Record<LensId, LensBoard>>
  handoff:
    | { mode: "post-review"; prLabel: string }
    | { mode: "rounds"; pr: { title: string; body: string; ready: boolean } }
  /** Pre-staged asks seeded into the comment store on scenario entry. */
  seedAsks?: AskSeed[]
}

import { teammateScenario } from "./teammate"

export const scenarios: Record<string, Scenario> = {
  teammate: teammateScenario,
}

export const DEFAULT_SCENARIO: ScenarioId = "teammate"

export function scenarioForSession(sessionId: string): Scenario | undefined {
  return Object.values(scenarios).find((scenario) => scenario.session.id === sessionId)
}
