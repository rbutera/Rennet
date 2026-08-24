import type { LensBoard } from "../lens-data"

/**
 * Decisions fixture — agent-drafted from PR #438
 * "fix(adapters): observe GitHub token refresh, drop the unsafe retry",
 * via packages/lens-instructions, then unslop-edited.
 *
 * Evidence anchors point at the merged tree. `inferred: false` marks decisions
 * the implementer stated in the PR body, commit messages, or the OpenSpec change
 * `openspec/changes/github-token-refresh-reliability/` (design.md / proposal.md).
 * `inferred: true` marks a call visible only in the code.
 */
export const decisionsBoard: LensBoard = {
  lens: "decisions",
  title: "Observe the GitHub token refresh, drop the unsafe retry",
  intro:
    "Seven judgment calls sit behind PR #438. The refresh path was already wired " +
    "and working, so the change is about what to make visible and, on review, what " +
    "to pull back out. The implementer stated six of them. The seventh, the log " +
    "line format, is read off the code.",
  sections: [
    {
      id: "scope",
      title: "What counts as the bug",
      gist: "The reframe that set the scope. The problem was invisible renewal, not a short lifetime.",
      counts: "1 decision · stated",
      elements: [
        {
          kind: "prose",
          text: "A field failure on lancelot reported the GitHub token expired and forced a device-flow re-auth. The obvious move, extend or disable the token's lifetime, dodges the real defect. The refresh exchange emitted zero logs, so nobody could tell a recoverable blip from a dead token, and the refresh had never once been confirmed to succeed.",
        },
        {
          kind: "decision",
          statement:
            "Treat the silent refresh exchange as the bug and add logging, rather than extending or disabling the GitHub App token lifetime.",
          why: "PR body: \"The token lifetime was never the bug — the bug was that renewal is invisible.\" The PR's \"Not in this PR\" section names \"Disabling token expiry (dodges the fix)\", and the OpenSpec proposal states \"The token's lifetime is not the bug.\" So the whole change ships log records instead of touching expiry.",
          inferred: false,
          alternatives: [
            "Disable or lengthen token expiry in the GitHub App config so refresh runs rarely. Dodges the fix.",
            "Leave the path silent and add only the retry, treating the failure as a resilience gap.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 244 },
            { path: "packages/server/src/create-server.ts", line: 626 },
            {
              path: "openspec/changes/github-token-refresh-reliability/proposal.md",
              line: 3,
            },
          ],
        },
      ],
    },
    {
      id: "secret-safe-observability",
      title: "Secret-safe observability",
      gist: "Logging the refresh without ever writing a credential to disk.",
      counts: "4 decisions · 3 stated, 1 inferred",
      elements: [
        {
          kind: "decision",
          statement:
            "Inject an optional `log?: (record) => void` sink into the resolve/refresh deps instead of calling `console.log` inside the adapter.",
          why: "OpenSpec design Decision 1: keep `adapters` testable and free of side effects, let tests assert on captured records, and format for production where the server is composed. `create-server` binds the concrete sink, which writes to the daemon's stdout and lands in `daemon.log`.",
          inferred: false,
          alternatives: [
            "A bare `console.error`/`console.log` inside `refreshAndPersist`. The design rejected it because it couples the adapter to a sink and makes the secret-safety guarantee untestable.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 102 },
            { path: "packages/server/src/create-server.ts", line: 626 },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              line: 37,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "Make `RefreshLogRecord` a typed shape with no field that can hold a token, refresh token, or secret. The type guarantees secret-freedom, so no reviewer has to.",
          why: "OpenSpec design Decision 2: the only fields are `phase`, an optional `githubError` holding a decline's error code, and an optional `tokenKind` holding a non-secret prefix. No field can carry a secret, so a credential cannot be logged even by mistake. The safety is a property of the type.",
          inferred: false,
          alternatives: [
            "Log the full refresh response or a richer record and rely on a redaction pass or reviewer vigilance to strip secrets.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 59 },
          ],
        },
        {
          kind: "decision",
          statement:
            "`tokenKind` returns a prefix from a closed allowlist, or the fixed string `\"token\"`, never a computed slice of the token body.",
          why: "OpenSpec design Decision 2 and task 5.3: an unrecognized value like `customerSecret_body` must map to `\"token\"`, never to a slice such as `customerSecret_`, so an unexpected credential can never leak bytes into a log. The adversarial unit test `tokenKind(\"customerSecret_body\") === \"token\"` pins this. Seeing the one-liner is the evidence it cannot slice.",
          inferred: false,
          alternatives: [
            "Derive the label from the token itself, e.g. the substring before the first `_`. That emits `customerSecret_` for an unexpected value and leaks part of a secret.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 72 },
            { path: "packages/adapters/src/github-auth.ts", line: 87 },
          ],
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 87,
          lang: "ts",
          code: 'export function tokenKind(token: string): string {\n  return GITHUB_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? "token";\n}',
          highlightLines: [88],
        },
        {
          kind: "decision",
          statement:
            "Serialize each record in `create-server` as a flat `key=value` `[github-auth]` line rather than JSON-stringifying the record object.",
          why: "The binding builds `phase=… githubError=… tokenKind=…` and prints one `[github-auth]` line, omitting absent optional fields. The choice of a grep-friendly flat line over `JSON.stringify(record)` shows up only in the code. No design note or commit gives a reason, so the intent is reconstructed: a scannable single line in `daemon.log`.",
          inferred: true,
          alternatives: [
            "`console.log(`[github-auth] ${JSON.stringify(record)}`)`. One structured line, machine-parseable but noisier to eyeball.",
          ],
          evidence: [
            { path: "packages/server/src/create-server.ts", line: 626 },
          ],
        },
      ],
    },
    {
      id: "retry-and-state-machine",
      title: "Retry ownership and the untouched state machine",
      gist: "The headline reversal, no retry here, plus what was deliberately left unchanged.",
      counts: "2 decisions · stated",
      elements: [
        {
          kind: "decision",
          statement:
            "Keep retry ownership in the shared GitHub transport and add none in `refreshAndPersist`. On a network error, log `network` and propagate. An earlier draft added an adapter-level retry; review removed it.",
          why: "OpenSpec design Decision 3 and the commit `fix(adapters): drop redundant refresh retry, allowlist tokenKind`: `withConnectResilience` already retries a connect-phase blip exactly once, and does so replay-safely because no request reached GitHub. A second retry here would be redundant, up to four connect attempts, and unsafe. `isGitHubNetworkError` also matches post-send errors that may have already rotated the pair, so retrying burns a rotated refresh token. The inline comment at the catch block spells this out.",
          inferred: false,
          alternatives: [
            "Retry the refresh inside `refreshAndPersist`, the earlier draft. Rejected for the double-connect-attempt and rotation-burn risk on an ambiguous post-send failure.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 254 },
            { path: "packages/adapters/src/github-auth.ts", line: 261 },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              line: 41,
            },
          ],
        },
        {
          kind: "decision",
          statement:
            "On a genuine decline, keep the stored credential file and return `token-invalid`, rather than clearing it so `status` reads `not-connected`.",
          why: "OpenSpec design Open Questions: clearing the credential on a persistent decline was considered and deferred. The current behavior, log the code, keep the file, return `token-invalid`, is acceptable now that the log makes the loop visible. Revisit only if the field shows churn. In code, the declined branch logs and returns null without writing to the store.",
          inferred: false,
          alternatives: [
            "Clear the credential on a persistent decline so `status` degrades to `not-connected` instead of re-attempting a dead refresh on each resolve.",
          ],
          evidence: [
            { path: "packages/adapters/src/github-auth.ts", line: 250 },
            {
              path: "openspec/changes/github-token-refresh-reliability/design.md",
              line: 57,
            },
          ],
        },
      ],
    },
  ],
}
