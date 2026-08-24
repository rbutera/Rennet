/**
 * Flagged lens fixture — dual-seat drafted from PR #438 via
 * packages/lens-instructions, reconciled, unslop-edited.
 * "fix(adapters): observe GitHub token refresh, drop the unsafe retry".
 *
 * The Claude seat and the Codex seat drafted independently on the same
 * instructions; this file is the reconciliation. Claude's finding and Codex's
 * third finding share one root cause (a refresh exit path with no terminal
 * record) and merge into f1, concurred 2/2. Codex raised two findings of its
 * own (f2, f3).
 */

import type { LensBoard } from "@/lib/lens-data"

export const flaggedBoard: LensBoard = {
  lens: "flagged",
  title: "Flagged",
  intro:
    "Three medium findings from two independent seats. Both seats land on the same hole. The outcome log this PR exists to add isn't guaranteed on every exit path. Codex also flags the retry allowlist and the post-send failure copy. Cleared concerns sit at the foot, not raised as findings.",
  sections: [
    {
      id: "flagged-medium",
      title: "Medium",
      gist: "Both seats caught a refresh that logs `attempt` and no outcome. Codex adds two more, on the retry allowlist and the post-send copy.",
      counts: "3 findings · 1 concurred · 2 Codex-only",
      elements: [
        {
          kind: "finding",
          id: "f1",
          title:
            "A refresh can log `attempt` and no outcome, on unexpected exchange errors and on persistence failure",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body:
            "The catch block emits a terminal record for only two cases. It logs `declined` when the error is `GitHubOAuthDeclined`, and `network` when `isGitHubNetworkError(error)` matches. Every other thrown error re-throws with just the `attempt` record in the log. Here is the trigger. `postLogin` throws a plain `Error` on any non-2xx from GitHub's token endpoint (github-device-flow.ts:112-113), so a GitHub 5xx during a refresh, routine during a GitHub incident, is neither a decline nor a network-coded error. daemon.log then shows `[github-auth] phase=attempt` and nothing after it, which reads the same as the process dying mid-exchange. That is exactly the observed-versus-inferred ambiguity this PR set out to remove. Codex found the same class plus a second member. If GitHub rotates successfully but `setGitHubCredential()` rejects (ENOSPC, EACCES), no terminal record is emitted and the stored pair is dead (github-auth.ts:264). The spec's own scenario 'An attempted refresh is logged with its outcome' enumerates persisted, declined, and network; neither input satisfies any of them. Fix: write a secret-safe terminal record on every exit path, covering the exchange-failure and persistence-failure outcomes.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 261 },
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 244,
          lang: "ts",
          code: [
            '    log({ phase: "attempt" });',
            "    let minted: GitHubCredential;",
            "    try {",
            "      minted = await refresh(current.refreshToken);",
            "    } catch (error) {",
            "      if (error instanceof GitHubOAuthDeclined) {",
            '        log({ phase: "declined", githubError: error.code });',
            "        return null;",
            "      }",
            "      // A non-network, non-declined error (e.g. a GitHub 5xx on the token",
            "      // endpoint → postLogin throws a plain Error) logs NO terminal record:",
            '      if (isGitHubNetworkError(error)) log({ phase: "network" });',
            "      throw error; // <- attempt already logged, no outcome for this class",
            "    }",
            "    await deps.secretStore.setGitHubCredential(minted);",
            '    log({ phase: "persisted", tokenKind: tokenKind(minted.token) });',
          ].join("\n"),
          highlightLines: [261, 262],
        },
        {
          kind: "finding",
          id: "f2",
          title: "Definite pre-send failure codes are missing from the connect-phase retry allowlist",
          severity: "medium",
          agreement: { claude: false, codex: true },
          body:
            "A refresh connection rejected with `ECONNREFUSED`, `EHOSTUNREACH`, or `ENETDOWN` cannot have delivered the POST, yet these codes are absent from `CONNECT_PHASE_CODES`. The transport skips the replay-safe retry it promises for pre-send failures, and auth drops to `network` even when a second attempt would succeed. Fix: add the definite pre-send codes and test them through `composeGitHubTransport`.",
          anchor: { path: "packages/server/src/github-fetch.ts", line: 18 },
        },
        {
          kind: "finding",
          id: "f3",
          title: "A post-send reset is reported as if the credential is definitely untouched",
          severity: "medium",
          agreement: { claude: false, codex: true },
          body:
            "GitHub can accept the refresh and rotate the pair, then the response connection resets (`ECONNRESET`). `isGitHubNetworkError` logs `phase=network` and the resolution copy claims the token is untouched. But GitHub invalidates the old pair after a successful rotation, so the next attempt gets `bad_refresh_token` and forces a fresh sign-in. Not retrying is correct, since a replay could double the rotation. The reporting is what's wrong. Fix: represent post-send failures as an unknown outcome instead of asserting validity.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 294 },
        },
        {
          kind: "prose",
          text: "Checked and cleared, not findings. (1) The `network` failure now throws straight out of `withAccountLock`, but the lock is a promise chain that resets via `accountLock = next.catch(() => undefined)` (create-server.ts:685-689), so it advances even when the section rejects. The lock never jams, and the path predates this PR. (2) The central claim that the transport owns the retry, so the refresh layer needs none, holds. `publishHttp` = `composeGitHubTransport(...)` wraps `withConnectResilience` (server/github-fetch.ts:105-110), and the refresh POST rides `publishHttp` (create-server.ts:620). (3) Secret-safety is sound. `RefreshLogRecord` has no secret-bearing field, `tokenKind` returns only an allowlisted constant, and the daemon's stdout is pinned to the daemon.log file fd (supervise.ts:92-100), not an IPC channel, so the `console.log` line cannot corrupt a protocol stream. (4) The four concerns in the previous demo fixture, correlation id, untested formatter, log injection via `githubError`, and tokenKind drift, have no nameable breaking input, and both seats rejected them.",
        },
      ],
    },
  ],
}
