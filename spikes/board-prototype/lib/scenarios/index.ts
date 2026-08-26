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

/** One line of the round report (the successor account, R34): what the round
 * did with one ask — or did beyond them — verified against the round's diff. */
export interface SummaryItem {
  status: "addressed" | "partial" | "untouched" | "beyond"
  /** The ask this traces back to (or the change, for a beyond-the-asks item). */
  ask: string
  note: string
  anchor?: { path: string; line: number }
}

/**
 * A completed round's record: the report the reviewer is greeted by, kept in
 * the session's rounds ledger so every earlier report stays readable. In the
 * product this pins the round's asks, worker commits, the frozen board
 * generation, and the patchset generation it minted (#457 append-then-freeze).
 */
export interface RoundReturn {
  number: number
  when: string
  greeting: string
  items: SummaryItem[]
  /** The regeneration's rework triggers, surfaced in the drafting activity feed. */
  triggers: string[]
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
  /** Completed rounds, oldest first — the rounds ledger. Present only once a
   * round has returned; the header's Rounds control exists exactly then. */
  rounds?: RoundReturn[]
}

import { teammateScenario } from "./teammate"
import { proposeScenario } from "./propose"
import { roundsScenario } from "./rounds"
import { returnedScenario } from "./returned"

export const scenarios: Record<string, Scenario> = {
  teammate: teammateScenario,
  propose: proposeScenario,
  rounds: roundsScenario,
  returned: returnedScenario,
}

export const DEFAULT_SCENARIO: ScenarioId = "teammate"

export function scenarioForSession(sessionId: string): Scenario | undefined {
  return Object.values(scenarios).find((scenario) => scenario.session.id === sessionId)
}
