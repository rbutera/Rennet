import type { ProjectIconName } from "@/components/project-icon"
import type { TargetKind } from "./target-language"

export interface SessionItem {
  id: string
  title: string
  time: string
  active?: boolean
  /** Orchestrator activity the reviewer hasn't opened yet — the verdigris dot. */
  unreadUpdates?: boolean
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

// First run opens with ZERO sessions (R54): the sidebar earns rows as the
// reviewer starts sessions from New Chat. Scenario sessions are added at
// start time by the store's addScenarioSession.

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
        sessions: [],
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
