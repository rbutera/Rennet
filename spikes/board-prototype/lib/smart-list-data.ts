/**
 * Smart-list fixtures for the New chat page — a project's unified list of
 * local working branches and GitHub pull requests (wireframe 05: one list,
 * no zones; a row's STATE gives it its look; PR row wins over its checked-out
 * worktree, which becomes an annotation).
 */

export type CiState = "pass" | "fail" | "running"

export type SmartListItem =
  | {
      kind: "pr"
      number: number
      title: string
      branch: string
      repo: string
      author: string
      adds: number
      dels: number
      files: number
      ci: CiState
      state: "needs-you" | "yours" | "team" | "merged"
      checkedOutLocally?: boolean
      /** Starting this row opens the named scenario session (SCENARIOS.md 1:1). */
      scenarioId?: string
    }
  | {
      kind: "local"
      branch: string
      repo: string
      dirty: boolean
      reviewed: boolean
      /** Extra context line, e.g. the spec-only proposal state. */
      note?: string
      scenarioId?: string
    }

export const smartList: Record<string, SmartListItem[]> = {
  p1: [
    {
      kind: "pr",
      number: 439,
      title: "feat(wsl): daemon-in-distro runtime",
      branch: "wsl-daemon-runtime",
      repo: "rennet",
      author: "priya",
      adds: 1724,
      dels: 31,
      files: 19,
      ci: "pass",
      state: "needs-you",
      scenarioId: "teammate",
    },
    {
      kind: "local",
      branch: "fix/token-refresh-observability",
      repo: "rennet",
      dirty: true,
      reviewed: false,
      scenarioId: "rounds",
    },
    {
      kind: "local",
      branch: "fix/token-refresh-observability",
      repo: "rennet",
      dirty: false,
      reviewed: false,
      note: "openspec proposal · spec only, nothing implemented",
      scenarioId: "propose",
    },
    {
      kind: "pr",
      number: 437,
      title: "feat(wsl): build the daemon launch descriptor",
      branch: "wsl-launch-descriptor",
      repo: "rennet",
      author: "you",
      adds: 361,
      dels: 42,
      files: 8,
      ci: "pass",
      state: "merged",
    },
  ],
  p2: [
    {
      kind: "pr",
      number: 212,
      title: "IPC token handshake",
      branch: "fix/ipc-token",
      repo: "billing-service",
      author: "you",
      adds: 310,
      dels: 22,
      files: 6,
      ci: "running",
      state: "yours",
    },
    {
      kind: "local",
      branch: "feat/webhook-backoff",
      repo: "billing-service",
      dirty: true,
      reviewed: false,
    },
  ],
}
