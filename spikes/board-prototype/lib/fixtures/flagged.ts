/**
 * flagged fixture, dual-seat drafted from PR #438 via packages/lens-instructions
 * (post-lanes rubric), reconciled, unslop-edited.
 */

import type { LensBoard } from "@/lib/lens-data"

export const flaggedBoard: LensBoard = {
  lens: "flagged",
  title: "Flagged",
  intro:
    "Two medium findings. The refresh logging this change exists to add does not fire on every exit path, and one network-failure message claims the credential is untouched when it is likely already dead.",
  sections: [
    {
      id: "flagged-medium",
      title: "Medium",
      gist: "A refresh can log `attempt` and no outcome, and a post-send reset is reported as if the token is definitely untouched.",
      counts: "2 findings",
      elements: [
        {
          kind: "finding",
          id: "f1",
          title:
            "A refresh can log `attempt` and never a terminal outcome on an unexpected exchange error or a persistence failure",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body:
            "`refreshAndPersist` logs `attempt` at the start of the exchange (packages/adapters/src/github-auth.ts:244), then a terminal record on only three routes: `declined`, `network`, and `persisted`. Two reachable exits emit `attempt` and nothing after it.\n\nBoth leave daemon.log showing `[github-auth] phase=attempt` and stopping, which reads the same as the process dying mid-exchange. That is the observed-versus-inferred ambiguity this change set out to remove. The spec scenario 'An attempted refresh is logged with its outcome' (enumerating persisted / declined / network) covers neither exit.",
          details: [
            {
              heading: "An exchange error that is neither decline nor network",
              body: "GitHub's token endpoint returns an OAuth decline as a 200-with-`error` body. A real 5xx, routine during a GitHub incident, makes `postLogin` throw a plain `Error` (packages/adapters/src/github-device-flow.ts:112). That error is not `GitHubOAuthDeclined`, and `isGitHubNetworkError` rejects it (packages/adapters/src/github-fetch.ts:53):\n\n- no `.code`\n- name `Error`\n- message not `fetch failed`\n\nSo control falls to the bare `throw error` at packages/adapters/src/github-auth.ts:262 with only `attempt` in the log.",
            },
            {
              heading: "A persistence failure after a successful rotation",
              body: "When GitHub rotates the pair but `setGitHubCredential(minted)` rejects on an ENOSPC or EACCES, the throw at packages/adapters/src/github-auth.ts:264 escapes the catch entirely. No terminal record lands, not `persisted` and not any other. The stored pair is now the old one GitHub just invalidated, a dead session with `attempt` as its only trace.",
            },
          ],
          fix: "Write a secret-free terminal record on every exit, covering the exchange-failure and persistence-failure outcomes.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 262 },
        },
        {
          kind: "code-ref",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 244,
          endLine: 266,
          highlightLines: [262, 264],
        },
        {
          kind: "finding",
          id: "f2",
          title:
            "A post-send connection reset is reported as if the credential is definitely untouched",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body:
            "GitHub can accept the refresh POST and rotate the pair, then reset the response connection with `ECONNRESET`. That code is not a connect-phase code (packages/server/src/github-fetch.ts:18), so the transport does not retry. That is the right call, since replaying a post-send exchange could double a rotation.\n\nBut `ECONNRESET` is in `NETWORK_CODES` (packages/adapters/src/github-fetch.ts:34), so the network path takes over:\n\n- `isGitHubNetworkError` matches\n- `refreshAndPersist` logs `phase=network` and propagates\n- `resolveGitHubAuth` returns `{ reason: \"network\", copy: COPY.network }` (packages/adapters/src/github-auth.ts:294)\n\nThat copy reads 'Your connection and token are untouched' (packages/adapters/src/github-auth.ts:133). The token is touched. GitHub rotates on the successful send, so the stored refresh token is now dead, and the next refresh gets `bad_refresh_token` and forces a fresh device sign-in. The message asserts a definite state the code cannot know after a post-send failure. Skipping the retry is right; the reporting is wrong.",
          fix: "Represent a post-send network failure as an unknown outcome rather than asserting the credential survived.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 295 },
        },
      ],
    },
    {
      id: "flagged-cleared",
      title: "Checked and cleared",
      startFolded: true,
      gist: "Four concerns verified safe: the retry allowlist gap, secret-safety, log injection, the account lock.",
      counts: "4 checks",
      elements: [
        {
          kind: "prose",
          text: "The connect-phase retry allowlist (`CONNECT_PHASE_CODES`, packages/server/src/github-fetch.ts:18) omits definite pre-send codes: `ECONNREFUSED`, `EHOSTUNREACH`, `ENETDOWN`. Their absence only means the one-shot retry does not fire for those blips. The failure still degrades to an honest `network` state with the credential untouched, since a refused or unreachable connection sent nothing. A missed retry, not a defect.\n\nSecret-safety holds. `RefreshLogRecord` has no field that can carry a token, `tokenKind` returns only an allowlisted constant or the fixed `\"token\"` (packages/adapters/src/github-auth.ts:59), and the log sink concatenates only `phase`, `githubError`, and `tokenKind` into one line (packages/server/src/create-server.ts:626). No credential reaches it.\n\n`githubError` is GitHub's own OAuth error code, a constrained token, so no nameable input injects a forged `[github-auth]` line into the log.\n\nThe account lock cannot jam. It resets via `accountLock = next.catch(() => undefined)` (packages/server/src/create-server.ts:687), so a rejected network refresh still advances the chain, and that path predates this change.",
        },
      ],
    },
  ],
}
