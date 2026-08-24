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
    }
  | {
      kind: "local"
      branch: string
      repo: string
      dirty: boolean
      reviewed: boolean
    }

export const smartList: Record<string, SmartListItem[]> = {
  p1: [
    {
      kind: "pr",
      number: 434,
      title: "Auth refactor: session scoping",
      branch: "auth-refactor-session-scoping",
      repo: "rennet",
      author: "priya",
      adds: 1412,
      dels: 435,
      files: 23,
      ci: "pass",
      state: "needs-you",
    },
    {
      kind: "pr",
      number: 441,
      title: "Streamed tool-call rendering in the transcript",
      branch: "feat/stream-tool-calls",
      repo: "rennet",
      author: "you",
      adds: 680,
      dels: 74,
      files: 18,
      ci: "fail",
      state: "yours",
      checkedOutLocally: true,
    },
    {
      kind: "local",
      branch: "feat/lens-rethink",
      repo: "rennet",
      dirty: true,
      reviewed: false,
    },
    {
      kind: "pr",
      number: 439,
      title: "Sidebar session ordering by recency",
      branch: "fix/session-order",
      repo: "rennet",
      author: "marco",
      adds: 96,
      dels: 12,
      files: 4,
      ci: "running",
      state: "team",
    },
    {
      kind: "local",
      branch: "fix/wsl-watcher",
      repo: "rennet",
      dirty: false,
      reviewed: true,
    },
    {
      kind: "pr",
      number: 438,
      title: "fix(adapters): observe GitHub token refresh, drop the unsafe retry",
      branch: "fix/token-refresh-observability",
      repo: "rennet",
      author: "you",
      adds: 423,
      dels: 188,
      files: 9,
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
