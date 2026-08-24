export interface SessionItem {
  id: string
  title: string
  time: string
  active?: boolean
}

export interface ProjectItem {
  id: string
  name: string
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
        sessions: [
          { id: "s1", title: "Review Priya's auth refactor", time: "now", active: true },
          { id: "s2", title: "Trace session-scoping regression", time: "1h" },
          { id: "s5", title: "Rewrite lens board schema", time: "2d" },
        ],
      },
      {
        id: "p0",
        name: "orbital",
        sessions: [],
      },
      {
        id: "p3",
        name: "docs-site",
        sessions: [{ id: "s6", title: "Migrate search index", time: "4d" }],
      },
    ],
  },
  {
    id: "h2",
    label: "dev-box",
    kind: "remote",
    projects: [
      {
        id: "p2",
        name: "billing-service",
        sessions: [
          { id: "s3", title: "Audit webhook retry backoff", time: "yesterday" },
          { id: "s4", title: "Reconcile invoice line items", time: "yesterday" },
        ],
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
        sessions: [{ id: "s7", title: "Profile inference latency", time: "3d" }],
      },
    ],
  },
]

export const projects: ProjectItem[] = hosts.flatMap((host) => host.projects)
