export type SettingsLayer = "builtin" | "detected" | "global" | "repo"

export interface KeyCommand {
  id: string
  label: string
  keys: string
}

/** Client-settings: keybinding overrides live in ~/.rennet/client-settings.json. */
export const keyCommands: KeyCommand[] = [
  { id: "search", label: "Search", keys: "⌘P" },
  { id: "commands", label: "Command menu", keys: "⌘K" },
  { id: "new-chat", label: "New chat", keys: "⌘N" },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: "⌘B" },
  { id: "toggle-chat", label: "Toggle chat", keys: "⌘J" },
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

export interface HostSettings {
  github: { connected: true; account: string } | { connected: false }
}

/** Daemon-settings scope: one per host, ~/.rennet/daemon-settings.json on that machine. */
export const hostSettings: Record<string, HostSettings> = {
  h1: { github: { connected: true, account: "rbutera" } },
  h2: { github: { connected: true, account: "rbutera" } },
  h3: { github: { connected: false } },
}
