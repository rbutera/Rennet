import { scenarioForSession, scenarios, type Scenario } from "@/lib/scenarios"
import type { HostItem } from "@/lib/sidebar-data"

export type SlugResolution =
  | { kind: "scenario"; scenario: Scenario; sessionId: string } // slug is a scenario id
  | { kind: "session"; sessionId: string } // slug matches a sidebar/store session but no scenario (e.g. s8, minted new-chat sessions)
  | { kind: "unknown"; slug: string }

export function resolveSlug(slug: string, hosts: HostItem[]): SlugResolution {
  const scenario = scenarios[slug]
  if (scenario) return { kind: "scenario", scenario, sessionId: scenario.session.id }
  const known = hosts.some((h) => h.projects.some((p) => p.sessions.some((s) => s.id === slug)))
  if (known) return { kind: "session", sessionId: slug }
  return { kind: "unknown", slug }
}

/** The route slug for a session row: scenario id when one maps (s2 → "rounds"), else the session id. */
export function slugForSession(sessionId: string): string {
  return scenarioForSession(sessionId)?.id ?? sessionId
}
