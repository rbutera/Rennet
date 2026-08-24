import type { LensBoard } from "@/lib/lens-data"

/**
 * noise fixture, agent-drafted from PR #438 via packages/lens-instructions
 * (post-lanes rubric), unslop-edited.
 *
 * PR #438 is "fix(adapters): observe GitHub token refresh, drop the unsafe
 * retry". A 9-file change that is almost all behavior and its specification, so
 * the skip-safe remainder is small on purpose: a barrel/import that echoes the
 * two new public names and the generated openspec scaffold stamp. The four spec
 * artifacts belong to another lane; the behavioral edit, its tests, and the
 * daemon wiring carry judgment, all left to other lenses via skippedHunks.
 */
export const noiseBoard: LensBoard = {
  lens: "noise",
  title: "Noise · observe GitHub token refresh (#438)",
  intro:
    "3 hunks set aside. Nothing dropped. Every group reopens into the full diff.",
  skippedHunks: [
    {
      path: "openspec/changes/github-token-refresh-reliability/proposal.md",
      reason:
        "Normative change intent — the bug is invisibility, the no-second-retry rationale, and the new github-token-refresh capability. Spec artifact.",
    },
    {
      path: "openspec/changes/github-token-refresh-reliability/design.md",
      reason:
        "The four decisions (injected logger seam, secret-free record type, retry ownership stays in the transport, unchanged persistence/classification) and their rejected alternatives. Spec artifact.",
    },
    {
      path: "openspec/changes/github-token-refresh-reliability/specs/github-token-refresh/spec.md",
      reason:
        "The added requirements and scenarios (observable exchange, named decline, replay-safe connect retry, credential untouched on network). Spec artifact and requirement coverage.",
    },
    {
      path: "openspec/changes/github-token-refresh-reliability/tasks.md",
      reason:
        "The change's task checklist, all boxes marked except the deferred lancelot field proof (6.x). Spec artifact.",
    },
    {
      path: "packages/adapters/src/github-auth.ts",
      reason:
        "The behavioral edit: the removed unsafe adapter-level retry, the attempt/declined/network/persisted emits, and the tokenKind allowlist helper. The judgment the reviewer must weigh.",
    },
    {
      path: "packages/adapters/src/github-auth.test.ts",
      reason:
        "The behavioral and secret-safety test bodies — exact record ordering, refresh() called exactly once, byte-unchanged credential, sentinel secret-freedom, and the tokenKind never-a-slice assertion. Signal; only the import-block widening is on this board.",
    },
    {
      path: "packages/server/src/create-server.ts",
      reason:
        "Binds the concrete daemon logger into resolveAuth and formats each record as one [github-auth] line to daemon.log — where decision 1 actually lands at the composition boundary.",
    },
  ],
  sections: [
    {
      id: "mechanical",
      title: "Mechanical & generated churn",
      gist: "A barrel/import that echoes the two new symbols, and the generated scaffold stamp.",
      counts: "2 groups · 3 hunks · judged by rule",
      elements: [
        {
          kind: "prose",
          text: "This change is almost all behavior and its specification. The mechanical remainder is an export and an import that grow to carry the two symbols the change introduced, plus the two-line scaffold stamp written when the change directory was created.",
        },
        {
          kind: "noise-group",
          label: "New public names added to the adapters barrel and test import",
          judgedBy: "rule",
          reason:
            "Both hunks only add the two symbols github-auth.ts introduces in this change, the RefreshLogRecord type and the tokenKind function, to a specifier list that already carries their siblings. No statement changed; the export and import lists grew to match the new source.",
          hunks: [
            {
              path: "packages/adapters/src/index.ts",
              summary: "adds RefreshLogRecord and tokenKind to the adapters barrel export",
            },
            {
              path: "packages/adapters/src/github-auth.test.ts",
              summary:
                "widens the single-symbol import to a named block pulling in RefreshLogRecord and tokenKind",
            },
          ],
        },
        {
          kind: "noise-group",
          label: "Generated openspec scaffold stamp",
          judgedBy: "rule",
          reason:
            "A two-line file the openspec tool writes when a change directory is created: a schema tag and a creation date. No requirement text, no behavior. The substantive spec files sit alongside it in the same directory.",
          hunks: [
            {
              path: "openspec/changes/github-token-refresh-reliability/.openspec.yaml",
              summary: "new file: schema: spec-driven and a created: 2026-08-20 stamp",
            },
          ],
        },
      ],
    },
  ],
}
