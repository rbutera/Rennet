import type { LensBoard } from "@/lib/lens-data"

/**
 * Noise fixture (agent-drafted from PR #438 via packages/lens-instructions,
 * unslop-edited). PR #438 is "fix(adapters): observe GitHub token refresh, drop
 * the unsafe retry". A tight 9-file PR with little true noise, so the board is
 * small on purpose. Set aside here: barrel/import plumbing that mirrors the new
 * public names, one generated openspec stamp plus its completed task checklist,
 * and the pure-function tokenKind table tests. Everything that carries a
 * reviewer's judgment stays off this board: the retry removal and log emits in
 * github-auth.ts, the logger binding in create-server.ts, the behavioral and
 * secret-safety tests, and the normative spec prose (proposal/design/spec.md).
 */
export const noiseBoard: LensBoard = {
  lens: "noise",
  title: "Noise · observe GitHub token refresh (#438)",
  intro:
    "7 hunks set aside from the reviewer's judgment. Nothing dropped. Every group reopens into the full diff.",
  sections: [
    {
      id: "mechanical",
      title: "Mechanical churn",
      gist: "Barrel and import plumbing that only echoes the new public names.",
      counts: "1 group · 2 hunks · judged by rule",
      elements: [
        {
          kind: "prose",
          text: "Noise is what this change touched but a reviewer can take on trust once they know the category. It does not repay line-by-line reading. Nothing is dropped. Each group names its hunks and reopens into the diff. The judgment stays with the reviewer: the retry removal and records emitted in github-auth.ts, the logger bound in create-server.ts, the behavioral and secret-safety tests, and the spec prose all stay off this board.",
        },
        {
          kind: "noise-group",
          label: "Barrel re-export & import plumbing",
          judgedBy: "rule",
          reason:
            "Both hunks add the two new public names, RefreshLogRecord and tokenKind, to export/import blocks that already list their siblings. No logic, and an exact match to the surrounding pattern.",
          hunks: [
            {
              path: "packages/adapters/src/index.ts",
              summary: "add RefreshLogRecord + tokenKind to the adapters barrel",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "widen the single-symbol import to a named block for the two new symbols",
            },
          ],
        },
      ],
    },
    {
      id: "bookkeeping",
      title: "OpenSpec bookkeeping & pure-function tests",
      gist: "A generated stamp, a done checklist, and fixed input/output table tests.",
      counts: "2 groups · 5 hunks · judged by llm",
      elements: [
        {
          kind: "noise-group",
          label: "OpenSpec scaffold stamp & completed task checklist",
          judgedBy: "llm",
          reason:
            "The .openspec.yaml is a two-line schema and created stamp the openspec tool writes. tasks.md is the same change's checklist with every box marked, so it mirrors what shipped and records no behavior. The normative spec (proposal/design/spec.md) is NOT here: it carries the no-retry rationale a reviewer needs.",
          hunks: [
            {
              path: "openspec/changes/github-token-refresh-reliability/.openspec.yaml",
              summary: "new 2-line schema + created stamp",
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/tasks.md",
              summary: "task checklist, all boxes marked (6.x lancelot proof still open)",
            },
          ],
        },
        {
          kind: "noise-group",
          label: "tokenKind allowlist table tests",
          judgedBy: "llm",
          reason:
            "Pure-function cases with fixed inputs and expected outputs over the tokenKind helper. Known prefixes map to themselves, and an unknown value maps to the fixed 'token', never a slice. Read and confirm, with no design decision to weigh.",
          hunks: [
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "known ghu_/gho_/github_pat_ map to their own prefix",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "customerSecret_body maps to 'token', asserted never a slice",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "no-underscore 'plainvalue' maps to 'token'",
            },
          ],
        },
      ],
    },
  ],
}
