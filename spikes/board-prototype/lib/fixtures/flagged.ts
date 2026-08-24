/**
 * Flagged lens fixture — findings raised against PR #438
 * "fix(adapters): observe GitHub token refresh, drop the unsafe retry".
 *
 * The change makes the GitHub credential refresh observable: `refreshAndPersist`
 * emits a secret-free `RefreshLogRecord` (`attempt` → `persisted`/`declined`/`network`),
 * a `tokenKind` allowlist keeps token bytes out of logs, and an earlier adapter-level
 * retry was removed in favour of the shared transport's connect-phase retry.
 *
 * Findings below are genuine concerns a careful reviewer could raise about that
 * diff, sorted by severity, each with cross-model concurrence (Claude + Codex
 * review independently). One finding is a disagreement — Codex raised it, Claude
 * did not.
 */

import type { LensBoard } from "@/lib/lens-data"

export const flaggedBoard: LensBoard = {
  lens: "flagged",
  title: "Flagged",
  intro:
    "Six concerns raised against the refresh-observability change. The models concur on all but one — a correlation-id gap Codex flagged and Claude judged moot under the account lock.",
  sections: [
    {
      id: "flagged-high",
      title: "High",
      gist: "The core promise — every attempt records its outcome — has a hole.",
      counts: "1 finding · 1 code",
      elements: [
        {
          kind: "finding",
          id: "f-dangling-attempt",
          title: "A non-network, non-declined refresh error leaves a dangling `attempt`",
          severity: "high",
          agreement: { claude: true, codex: true },
          body:
            "The catch block only emits a `declined` record for `GitHubOAuthDeclined` and a `network` record when `isGitHubNetworkError(error)` matches; every other thrown error re-throws with only the `attempt` record already logged. A parse failure, an unexpected 5xx mapped to a plain Error, or any bug in `refresh` therefore produces an `attempt` line in daemon.log with no matching outcome — exactly the observed-vs-inferred gap this PR exists to close. The proposal states 'on completion logs the outcome', but one whole class of failures never reaches a completion record.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 260 },
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 244,
          lang: "ts",
          code: [
            "    log({ phase: \"attempt\" });",
            "    let minted: GitHubCredential;",
            "    try {",
            "      minted = await refresh(current.refreshToken);",
            "    } catch (error) {",
            "      // A decline is deterministic — name its cause; the surface resolves token-invalid.",
            "      if (error instanceof GitHubOAuthDeclined) {",
            "        log({ phase: \"declined\", githubError: error.code });",
            "        return null;",
            "      }",
            "      // NO retry here. The shared GitHub transport already retries a",
            "      // CONNECT-PHASE blip once, replay-safely, and never replays a post-send",
            "      // failure. So observe the network failure and propagate it.",
            "      if (isGitHubNetworkError(error)) log({ phase: \"network\" });",
            "      throw error;",
            "    }",
            "    await deps.secretStore.setGitHubCredential(minted);",
            "    log({ phase: \"persisted\", tokenKind: tokenKind(minted.token) });",
          ].join("\n"),
          highlightLines: [260, 261],
        },
      ],
    },
    {
      id: "flagged-medium",
      title: "Medium",
      gist: "Lock release on the new throw path, log correlation, and an untested sink.",
      counts: "3 findings",
      elements: [
        {
          kind: "finding",
          id: "f-lock-on-throw",
          title: "The `network` throw now propagates through the account lock unverified",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body:
            "With the adapter-level retry removed, a network failure now `throw`s straight out of the `exclusively(...)` section, which is `withAccountLock` in create-server. Nothing in this diff proves the lock is released when the section rejects — if `withAccountLock` does not release on throw, a transient refresh failure would wedge the daemon's account lock and block every later resolve. The added tests assert record ordering and the credential being untouched, but none exercises lock release on the rejecting path.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 261 },
        },
        {
          kind: "finding",
          id: "f-correlation-id",
          title: "No correlation id ties an `attempt` line to its outcome",
          severity: "medium",
          // Disagreement: Codex raised it; Claude did not.
          agreement: { claude: false, codex: true },
          body:
            "Codex: the record has only a `phase` and optional cause fields, so once create-server flattens several exchanges into one daemon.log stream there is nothing to pair a given `attempt` with the `persisted`/`declined`/`network` that resolves it. Under log rotation, interleaving with other daemon output, or a proactive-plus-reactive refresh in the same window, an operator cannot reliably reconstruct which attempt had which outcome — the exact diagnosis the change is meant to enable. A short exchange id on `RefreshLogRecord` would close it.",
          anchor: { path: "packages/server/src/create-server.ts", line: 625 },
        },
        {
          kind: "finding",
          id: "f-sink-untested",
          title: "The create-server log formatter is untested; secret-safety is proven only on the record",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body:
            "The secret-safety tests stringify the `RefreshLogRecord` object and assert no token appears, but the string that actually lands in daemon.log is built separately in create-server by interpolating `phase`/`githubError`/`tokenKind` into a `[github-auth]` line. That formatting path has no test at all, so the guarantee 'nothing here can leak a credential' rests on the record type plus an unverified formatter. A future field added to the record would compile and log without any test catching it.",
          anchor: { path: "packages/server/src/create-server.ts", line: 629 },
        },
      ],
    },
    {
      id: "flagged-low",
      title: "Low",
      gist: "Log injection on the verbatim GitHub code, and silent token-kind drift.",
      counts: "2 findings",
      elements: [
        {
          kind: "finding",
          id: "f-log-injection",
          title: "`githubError` is interpolated into the log line without sanitization",
          severity: "low",
          agreement: { claude: true, codex: true },
          body:
            "The daemon writes `githubError=${record.githubError}` straight into the `[github-auth]` line, and the value is GitHub's verbatim `error` code. Today that field is a known OAuth enum, but if it ever carried a newline or a crafted string it could forge a second `[github-auth]` line in daemon.log — classic log injection. Low likelihood given the fixed GitHub vocabulary, but the code trusts an external field verbatim in a log sink.",
          anchor: { path: "packages/server/src/create-server.ts", line: 627 },
        },
        {
          kind: "finding",
          id: "f-tokenkind-drift",
          title: "Unknown GitHub prefixes silently collapse to `\"token\"`",
          severity: "low",
          agreement: { claude: true, codex: true },
          body:
            "`tokenKind` is a closed allowlist — correct for secret-safety, since an unrecognized value maps to the fixed `\"token\"` rather than a slice. The trade-off is log fidelity: when GitHub introduces a new credential prefix, every `persisted` record for it reads `tokenKind=token`, quietly losing the kind signal the record exists to carry, with nothing to flag that the allowlist has fallen behind.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 96 },
        },
      ],
    },
  ],
}
