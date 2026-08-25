/**
 * Context-map fixtures lifted from the real Rennet repo: the package scopes,
 * their true dependency edges (CLAUDE.md package boundaries), and a knowledge
 * layer of evidence-backed statements in the shipped feature's shape.
 */

export interface MapScope {
  name: string
  root: string
  files: number
  tests: number
  /** Scopes this scope imports. */
  out: string[]
  sampleFiles: string[]
}

export interface MapStatement {
  id: string
  subject: string
  claim: string
  confidence: "high" | "medium" | "low"
  status: "proposed" | "confirmed" | "rejected"
  evidence: string[]
}

export const mapBase = { repoKey: "rbutera/rennet", ref: "main", oid: "af509dbd4c21" }

export const mapScopes: MapScope[] = [
  { name: "@rennet/types", root: "packages/types", files: 14, tests: 6, out: [], sampleFiles: ["src/index.ts", "src/result.ts"] },
  { name: "@rennet/theme", root: "packages/theme", files: 9, tests: 2, out: [], sampleFiles: ["src/tokens.css", "src/index.ts"] },
  { name: "@rennet/protocol", root: "packages/protocol", files: 21, tests: 11, out: ["@rennet/types"], sampleFiles: ["src/index.ts", "src/bridge.ts"] },
  { name: "@rennet/instructions", root: "packages/instructions", files: 17, tests: 8, out: ["@rennet/types"], sampleFiles: ["src/lenses.ts", "src/unslop.ts"] },
  { name: "@rennet/core", root: "packages/core", files: 48, tests: 31, out: ["@rennet/types", "@rennet/protocol", "@rennet/instructions"], sampleFiles: ["src/settings-resolver.ts", "src/locus.ts", "src/review-pipeline.ts"] },
  { name: "@rennet/adapters", root: "packages/adapters", files: 62, tests: 39, out: ["@rennet/types", "@rennet/protocol", "@rennet/instructions", "@rennet/core"], sampleFiles: ["src/claude-adapter.ts", "src/codex-adapter.ts", "src/file-config-store.ts", "src/github-auth.ts"] },
  { name: "@rennet/server", root: "packages/server", files: 44, tests: 26, out: ["@rennet/types", "@rennet/protocol", "@rennet/instructions", "@rennet/core", "@rennet/adapters"], sampleFiles: ["src/dispatch.ts", "src/settings.ts", "src/review-pipeline-input.ts"] },
  { name: "@rennet/client", root: "packages/client", files: 12, tests: 7, out: ["@rennet/types", "@rennet/protocol"], sampleFiles: ["src/bridge-client.ts"] },
  { name: "@rennet/ui", root: "packages/ui", files: 38, tests: 12, out: ["@rennet/types", "@rennet/theme"], sampleFiles: ["src/button.tsx", "src/dialog.tsx", "src/command.tsx"] },
  { name: "@rennet/app-ui", root: "packages/app-ui", files: 87, tests: 52, out: ["@rennet/types", "@rennet/protocol", "@rennet/theme", "@rennet/ui"], sampleFiles: ["src/components/settings-screen.tsx", "src/components/context-map-view.tsx", "src/components/project-detail.tsx"] },
  { name: "apps/desktop", root: "apps/desktop", files: 33, tests: 14, out: ["@rennet/server", "@rennet/client", "@rennet/app-ui"], sampleFiles: ["src/index.ts", "src/preload.ts"] },
  { name: "docs", root: "docs", files: 71, tests: 0, out: [], sampleFiles: ["README.md", "using/concepts/product-and-vision.md"] },
]

export function scopeIns(name: string): string[] {
  return mapScopes.filter((scope) => scope.out.includes(name)).map((scope) => scope.name)
}

export const mapStatements: MapStatement[] = [
  {
    id: "k1",
    subject: "@rennet/adapters",
    claim: "The Claude adapter spawns the user's installed claude binary through pathToClaudeCodeExecutable — it authenticates with the user's subscription and never bundles a harness binary.",
    confidence: "high",
    status: "confirmed",
    evidence: ["packages/adapters/src/claude-adapter.ts"],
  },
  {
    id: "k2",
    subject: "@rennet/core",
    claim: "Settings resolution always returns provenance with the value; there is no bare resolve(key) — the surface renders the resolver's own answer.",
    confidence: "high",
    status: "confirmed",
    evidence: ["packages/core/src/settings-resolver.ts"],
  },
  {
    id: "k3",
    subject: "@rennet/server",
    claim: "dispatch.ts is the single RPC entry point; every bridge method routes through it, so auditing the surface means reading one file.",
    confidence: "medium",
    status: "confirmed",
    evidence: ["packages/server/src/dispatch.ts"],
  },
  {
    id: "k4",
    subject: "@rennet/adapters",
    claim: "GitHub egress is bounded to a single module; a network failure is kept distinct from an authentication failure everywhere it surfaces.",
    confidence: "medium",
    status: "confirmed",
    evidence: ["packages/adapters/src/github-auth.ts"],
  },
  {
    id: "k5",
    subject: "@rennet/app-ui",
    claim: "app-ui imports only types, protocol, theme, and ui — it never reaches into core or adapters, so every screen is testable off-Electron.",
    confidence: "high",
    status: "confirmed",
    evidence: ["packages/app-ui/package.json"],
  },
  {
    id: "k6",
    subject: "apps/desktop",
    claim: "The desktop app owns the daemon lifecycle; tray-resident mode keeps the daemon and streams alive with no open window.",
    confidence: "low",
    status: "rejected",
    evidence: ["apps/desktop/src/index.ts"],
  },
]
