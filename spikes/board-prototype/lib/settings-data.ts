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

/**
 * A source-control tool as detected on one host. Rennet rides the CLIs the
 * host already has: `gh` for GitHub (#483), `glab` for GitLab, and a plain API
 * token for Bitbucket, which has no official CLI (#484).
 */
export interface SourceControlTool {
  id: "git" | "gh" | "glab" | "bitbucket"
  label: string
  /** The tool's own version line; absent when nothing was found to ask. */
  version?: string
  status: "available" | "not-authenticated" | "not-installed" | "unreachable"
  /** One line of honest state and the fix. Backticks render as code. */
  detail: string
  enabled: boolean
}

/**
 * Detection is per host — the tools live on that machine, not in the client.
 * A host with no entry is one Rennet could not reach to look.
 */
export const sourceControl: Record<string, SourceControlTool[]> = {
  h1: [
    {
      id: "git",
      label: "Git",
      version: "git version 2.51.0",
      status: "available",
      detail: "Diffs, branches, and worktrees run through this git.",
      enabled: true,
    },
    {
      id: "gh",
      label: "GitHub",
      version: "gh version 2.76.0",
      status: "available",
      detail: "Rennet rides the `gh` CLI, signed in as rbutera.",
      enabled: true,
    },
    {
      id: "glab",
      label: "GitLab",
      status: "not-installed",
      detail: "Install the GitLab CLI (`brew install glab`) and sign in with `glab auth login`.",
      enabled: false,
    },
    {
      id: "bitbucket",
      label: "Bitbucket",
      status: "not-authenticated",
      detail: "Set a Bitbucket API token (repository + pull request scopes) in this host's credentials.",
      enabled: false,
    },
  ],
  h2: [
    {
      id: "git",
      label: "Git",
      version: "git version 2.43.0",
      status: "available",
      detail: "Diffs, branches, and worktrees run through this git.",
      enabled: true,
    },
    {
      id: "gh",
      label: "GitHub",
      version: "gh version 2.74.0",
      status: "not-authenticated",
      detail: "Run `gh auth login` on dev-box.",
      enabled: true,
    },
    {
      id: "glab",
      label: "GitLab",
      status: "not-installed",
      detail: "Install the GitLab CLI (`sudo apt install glab`) and sign in with `glab auth login`.",
      enabled: false,
    },
    {
      id: "bitbucket",
      label: "Bitbucket",
      status: "not-authenticated",
      detail: "Set a Bitbucket API token (repository + pull request scopes) in this host's credentials.",
      enabled: false,
    },
  ],
  // gpu-01 is not connected, so nothing can be detected on it.
  h3: [],
}

/**
 * What an environment IS, as opposed to what it can talk to: the machine, its
 * address, and the Rennet daemon running on it. Unknown fields stay absent —
 * an unreachable host has nothing to report, and says so.
 */
export interface EnvironmentInfo {
  os: "macos" | "linux" | "windows" | "wsl"
  /** Absent for the local machine — there is nothing to dial. */
  address?: string
  /** The daemon's version on that host; absent when it could not be asked. */
  daemonVersion?: string
  daemonUpdateAvailable?: boolean
  reachable: boolean
}

/** The version a daemon update lands on — the local machine already runs it. */
export const LATEST_DAEMON = "1.0.1"

export const environments: Record<string, EnvironmentInfo> = {
  h1: { os: "macos", daemonVersion: LATEST_DAEMON, reachable: true },
  h2: {
    os: "linux",
    address: "dev-box.tailnet.ts.net",
    daemonVersion: "1.0.0",
    daemonUpdateAvailable: true,
    reachable: true,
  },
  // A Windows box running the daemon inside WSL, currently off the network.
  h3: { os: "wsl", address: "gpu-01.tailnet.ts.net", reachable: false },
}
