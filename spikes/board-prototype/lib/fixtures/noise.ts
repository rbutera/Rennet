import type { LensBoard } from "@/lib/lens-data"

/**
 * Noise lens for PR #438 — "fix(adapters): observe GitHub token refresh, drop the
 * unsafe retry". Groups hunks the diff touched but that carry no code-review
 * judgment: spec artifacts, barrel plumbing, and low-judgment table tests. The
 * actual judgment (the retry removal in github-auth.ts, the logger binding in
 * create-server.ts) is deliberately NOT here — it belongs to the reviewer.
 */
export const noiseBoard: LensBoard = {
  lens: "noise",
  title: "Noise · observe GitHub token refresh (#438)",
  intro:
    "13 hunks set aside from the reviewer's judgment. Nothing dropped — every group reopens.",
  sections: [
    {
      id: "mechanical",
      title: "Mechanical churn",
      gist: "Spec artifacts and barrel plumbing — settled by a deterministic rule.",
      counts: "2 groups · 7 hunks · judged by rule",
      elements: [
        {
          kind: "prose",
          text: "Noise is what this change touched but that does not need your judgment: a deterministic rule or a labeled noise job sorted it here. Nothing is dropped or hidden — each group names its hunks and reopens into the full diff. The two hunks that do carry judgment — the retry removed in github-auth.ts and the logger bound in create-server.ts — are not in this lens.",
        },
        {
          kind: "noise-group",
          label: "OpenSpec change artifacts",
          judgedBy: "rule",
          reason:
            "Every file lives under openspec/changes/**, which the rule treats as spec prose rather than shipped runtime code.",
          hunks: [
            {
              path: "openspec/changes/github-token-refresh-reliability/.openspec.yaml",
              summary: "new schema+created stub",
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/proposal.md",
              summary: "why/what-changes prose",
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              summary: "decisions and trade-offs prose",
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/specs/github-token-refresh/spec.md",
              summary: "ADDED requirements + scenarios",
            },
            {
              path: "openspec/changes/github-token-refresh-reliability/tasks.md",
              summary: "task checklist, all boxes marked",
            },
          ],
        },
        {
          kind: "noise-group",
          label: "Barrel re-exports & import plumbing",
          judgedBy: "rule",
          reason:
            "Both hunks only add the new public names to existing alphabetized export/import blocks — no logic, matches the surrounding pattern exactly.",
          hunks: [
            {
              path: "packages/adapters/src/index.ts",
              summary: "add RefreshLogRecord + tokenKind to the barrel",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "single import widened to a named block",
            },
          ],
        },
      ],
    },
    {
      id: "low-judgment-tests",
      title: "Low-judgment test scaffolding",
      gist: "Table tests and repeated sentinel assertions — a noise job read them, nothing to weigh.",
      counts: "2 groups · 6 hunks · judged by llm",
      elements: [
        {
          kind: "noise-group",
          label: "tokenKind allowlist table tests",
          judgedBy: "llm",
          reason:
            "Pure-function cases with fixed inputs and expected outputs; the noise job flagged them as read-and-confirm, with no design decision to review.",
          hunks: [
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "known prefixes map to their own prefix",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "unknown value maps to 'token', never a slice",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "no-underscore value maps to 'token'",
            },
          ],
        },
        {
          kind: "noise-group",
          label: "Secret-safety sentinel boilerplate",
          judgedBy: "llm",
          reason:
            "The same sentinel-token setup and JSON.stringify().not.toContain() sweep repeats across three outcome paths; the noise job clustered the identical structure.",
          hunks: [
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "success path: neither token leaks into a record",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "network path: stored tokens absent from records",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary: "declined path: sentinel access/refresh not serialized",
            },
          ],
        },
      ],
    },
  ],
}
