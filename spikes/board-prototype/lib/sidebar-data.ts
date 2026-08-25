import type { ProjectIconName } from "@/components/project-icon"
import type { TargetKind } from "./target-language"

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

export const hosts: HostItem[] = [
  {
    id: "h1",
    label: "This machine",
    kind: "local",
    projects: [
      {
        id: "p1",
        name: "rennet",
        repo: "rbutera/rennet",
        // Session rows derive from the scenario registry (SCENARIOS.md):
        // each row lands with its scenario's build step, never before.
        sessions: [
          { id: "s1", title: "Review Priya's auth refactor", time: "now", active: true, target: "teammate-pr", targetState: "needs-you" },
          { id: "s2", title: "Token refresh before the PR", time: "1h", target: "your-branch" },
          { id: "s3", title: "Token refresh proposal", time: "2d", target: "your-branch", pinned: true },
          { id: "s8", title: "Lens board palette spike", time: "3w", target: "your-branch", targetState: "reviewed", archived: true },
        ],
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

export const projects: ProjectItem[] = hosts.flatMap((host) => host.projects)
