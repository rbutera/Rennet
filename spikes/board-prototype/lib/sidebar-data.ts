import type { ProjectIconName } from "@/components/project-icon"
import type { TargetKind } from "./target-language"
import { scenarios } from "@/lib/scenarios"

export interface SessionItem {
  id: string
  title: string
  time: string
  active?: boolean
  /** The unified review-target vocabulary (CONTEXT.md "Session targets"). */
  target: TargetKind
  targetState?: "needs-you" | "merged" | "reviewed"
  /** Pinned sessions surface in the sidebar's Pinned section. */
  pinned?: boolean
  /** Archived sessions leave the project list for the Archived drawer. */
  archived?: boolean
}

export interface ProjectItem {
  id: string
  /** Display name; defaults to the repo slug until the user renames it. */
  name: string
  /** org-name/repo-name — the identity the name falls back to. */
  repo: string
  /** Sidebar glyph; undefined renders the default. */
  icon?: ProjectIconName
  sessions: SessionItem[]
  /** True while the project is still being processed after being added. */
  indexing?: boolean
}

export interface HostItem {
  id: string
  label: string
  kind: "local" | "remote"
  projects: ProjectItem[]
}

// Session rows for p1 derive from the scenario registry (SCENARIOS.md): one row
// per unique session id, first scenario wins (rounds+returned share s2). s8 is
// a deliberate literal — it has no scenario. The scenarios→sidebar import is
// type-only on the scenarios side, so this static import forms no runtime cycle.
function p1Sessions(): SessionItem[] {
  const seen = new Set<string>()
  const derived: SessionItem[] = []
  for (const scenario of Object.values(scenarios)) {
    if (seen.has(scenario.session.id)) continue
    seen.add(scenario.session.id)
    derived.push(scenario.session)
  }
  return [
    ...derived,
    { id: "s8", title: "Lens board palette spike", time: "3w", target: "your-branch", targetState: "reviewed", archived: true },
  ]
}

/** The seed sidebar tree the store starts from. Fresh copy per call. */
export function buildInitialHosts(): HostItem[] {
  return [
  {
    id: "h1",
    label: "This Machine",
    kind: "local",
    projects: [
      {
        id: "p1",
        name: "rennet",
        repo: "rbutera/rennet",
        sessions: p1Sessions(),
      },
      {
        id: "p0",
        name: "orbital",
        repo: "rbutera/orbital",
        icon: "rocket",
        sessions: [],
      },
    ],
  },
  {
    id: "h2",
    label: "dev-box",
    kind: "remote",
    projects: [
      {
        // Never renamed — the name still carries its org/repo default.
        id: "p2",
        name: "meridian/billing-service",
        repo: "meridian/billing-service",
        icon: "credit-card",
        sessions: [],
      },
    ],
  },
  {
    id: "h3",
    label: "gpu-01",
    kind: "remote",
    projects: [
      {
        id: "p4",
        name: "ranking-model",
        repo: "meridian/ranking-model",
        icon: "cpu",
        sessions: [],
      },
    ],
  },
  ]
}
