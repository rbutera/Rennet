export type SettingsLayer = "builtin" | "detected" | "global" | "repo"

/** Settings splits into pages; per-project and shortcuts grow large (#476). */
export type SettingsPage = "machine" | "appearance" | "shortcuts" | "projects"

export interface KeyCommand {
  id: string
  label: string
  keys: string
}

/** Client-settings: keybinding overrides live in ~/.rennet/client-settings.json. */
export const keyCommands: KeyCommand[] = [
  { id: "search", label: "Search", keys: "⌘P" },
  { id: "commands", label: "Command Menu", keys: "⌘K" },
  { id: "new-chat", label: "New Chat", keys: "⌘N" },
  { id: "toggle-sidebar", label: "Toggle Sidebar", keys: "⌘B" },
  { id: "toggle-chat", label: "Toggle Chat", keys: "⌘J" },
  { id: "settings", label: "Settings", keys: "⌘," },
]

export interface GuidanceRule {
  rule: string
  severity: "high" | "medium" | "low"
}

export interface ProjectSettings {
  visibility: { value: "local" | "git-visible"; layer: SettingsLayer }
  promoted: boolean
  locus: { value: string; layer: SettingsLayer }
  guidance: GuidanceRule[]
}

export const projectSettings: Record<string, ProjectSettings> = {
  p1: {
    visibility: { value: "local", layer: "builtin" },
    promoted: false,
    locus: { value: "This machine", layer: "detected" },
    guidance: [
      { rule: "Token refresh paths need a failing-first test", severity: "high" },
      { rule: "No new dependencies without a licence check", severity: "medium" },
      { rule: "Prefer table-driven tests in adapters", severity: "low" },
    ],
  },
  p0: {
    visibility: { value: "local", layer: "builtin" },
    promoted: false,
    locus: { value: "This machine", layer: "detected" },
    guidance: [],
  },
  p3: {
    visibility: { value: "git-visible", layer: "repo" },
    promoted: true,
    locus: { value: "This machine", layer: "detected" },
    guidance: [{ rule: "Broken links fail the build — check anchors", severity: "medium" }],
  },
  p2: {
    visibility: { value: "local", layer: "builtin" },
    promoted: false,
    locus: { value: "dev-box", layer: "detected" },
    guidance: [
      { rule: "Money amounts are integer cents, never floats", severity: "high" },
      { rule: "Webhook handlers must be idempotent", severity: "high" },
    ],
  },
  p4: {
    visibility: { value: "local", layer: "builtin" },
    promoted: false,
    locus: { value: "gpu-01", layer: "detected" },
    guidance: [],
  },
}

export interface WorktreeSettings {
  /** Directory new worktrees are created under. */
  root: string
  /** Directory-name pattern; tokens resolve per session. */
  pattern: string
}

export const defaultWorktrees: WorktreeSettings = {
  root: "~/.rennet/worktrees",
  pattern: "{project}-{branch}",
}

export interface WorktreeToken {
  token: string
  label: string
  sample: string
}

/** Tokens the naming pattern understands, with sample values for the preview. */
export const worktreeTokens: WorktreeToken[] = [
  { token: "{project}", label: "project", sample: "" }, // sample = the project's name
  { token: "{branch}", label: "branch", sample: "fix/session-scope" },
  { token: "{pr}", label: "PR number", sample: "482" },
  { token: "{user}", label: "user", sample: "rai" },
  { token: "{date}", label: "date", sample: "2026-08-25" },
]

/** Resolve a pattern against sample values; slashes become dashes in dir names. */
export function previewWorktreeName(pattern: string, projectName: string): string {
  let out = pattern
  for (const t of worktreeTokens) {
    out = out.replaceAll(t.token, t.token === "{project}" ? projectName : t.sample)
  }
  return out.replaceAll("/", "-")
}

export interface HostSettings {
  github: { connected: true; account: string } | { connected: false }
}

/** Daemon-settings scope: one per host, ~/.rennet/daemon-settings.json on that machine. */
export const hostSettings: Record<string, HostSettings> = {
  h1: { github: { connected: true, account: "rbutera" } },
  h2: { github: { connected: true, account: "rbutera" } },
  h3: { github: { connected: false } },
}
