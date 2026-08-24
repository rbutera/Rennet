/**
 * Spec-lens fixture — PR #438 "fix(adapters): observe GitHub token refresh, drop
 * the unsafe retry" (rbutera/rennet). The Spec lens is a structured-artifact
 * viewer: it renders the SHAPE of the discovered spec (header roll-up,
 * what-changes spine, capability grid, requirement rows with coverage, task
 * progress), never the raw markdown. Content derived from the real proposal,
 * spec.md, diff, and test file.
 */

import type { LensBoard } from "@/lib/lens-data"

export const specBoard: LensBoard = {
  lens: "spec",
  title: "Spec — GitHub token refresh, observed",
  wide: true,
  sections: [
    {
      id: "change",
      title: "The change",
      gist: "observe-github-token-refresh · 2 new capabilities · 1 modified · tasks 11/13.",
      elements: [
        {
          kind: "spec-header",
          change: "observe-github-token-refresh",
          source: "openspec/changes/observe-github-token-refresh",
          format: "OpenSpec",
          counts: { added: 2, modified: 1 },
          tasks: { done: 11, total: 13 },
          why: "The token's lifetime was never the bug: renewal was silent. A failed refresh looked identical to a missing credential, and the refresh layer's own retry could double a rotation. This change makes every refresh observable through a secret-free log record and moves retry ownership to the shared transport.",
        },
        {
          kind: "what-changes",
          rows: [
            {
              tag: "refresh-log",
              text: "A RefreshLogRecord type with no field able to hold a credential, emitted through an injected logger on every attempt and outcome.",
            },
            {
              tag: "classification",
              text: "Declines carry the verbatim GitHub error code and resolve token-invalid; network failures leave the credential byte-identical.",
            },
            {
              tag: "retry-ownership",
              text: "The refresh path loses its own retry; the shared connect-resilient transport absorbs connect-phase blips exactly once.",
            },
          ],
          impact:
            "packages/adapters only. No new package, no dependency change. The logger is injected, so the daemon owns where records land (daemon.log). Out of scope: the Wave 6 field proof on lancelot.",
        },
        {
          kind: "capability-grid",
          capabilities: [
            {
              slug: "refresh-observability",
              state: "added",
              requirements: 4,
              scenarios: 8,
              sectionId: "observability",
            },
            {
              slug: "failure-classification",
              state: "added",
              requirements: 4,
              scenarios: 5,
              sectionId: "classification-retry",
            },
            {
              slug: "github-auth",
              state: "modified",
              requirements: 1,
              scenarios: 1,
              sectionId: "field-proof",
            },
          ],
        },
      ],
    },
    {
      id: "observability",
      title: "refresh-observability",
      badge: "added",
      gist: "Every refresh attempt lands one secret-free line in daemon.log, by construction.",
      counts: "4 requirements · 3 covered · 1 partial",
      elements: [
        {
          kind: "prose",
          text: "Before this change the refresh exchange emitted zero logs, so a field failure could only be inferred and a success had never been confirmed once. The change obligates the daemon to record each attempt and its outcome through an injected logger, using a record type that has no field able to hold a credential.",
        },
        {
          kind: "requirement",
          name: "Every refresh is recorded",
          delta: "added",
          text: "The daemon SHALL record every credential refresh attempt and its outcome — persisted, declined, or network — to daemon.log through an injected logger, so a field failure is observed rather than inferred.",
          status: "covered",
          coverage: { hunks: 3, tests: 4 },
          refs: ["github-auth.test.ts"],
          scenarios: [
            "WHEN the daemon resolves a credential near or past expiry and attempts a refresh THEN it logs an `attempt` record, then the outcome record on completion.",
            "WHEN a refresh persists the rotated pair THEN a `persisted` record is emitted after setGitHubCredential.",
          ],
        },
        {
          kind: "requirement",
          name: "The record cannot hold a secret",
          delta: "added",
          text: "A RefreshLogRecord SHALL carry no token, refresh token, or secret field, so a credential cannot be logged even by mistake — the safety is a type-level property, not a review promise.",
          status: "covered",
          coverage: { hunks: 1, tests: 3 },
          refs: ["github-auth.test.ts"],
          scenarios: [
            "WHEN any refresh record is written THEN it contains no access token, refresh token, or secret value.",
            "WHEN a full refresh (attempt → persisted) runs with sentinel tokens THEN neither the old nor the rotated token string appears in any serialized record.",
          ],
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 407,
          lang: "ts",
          highlightLines: [1, 2, 3, 4, 5, 6, 7],
          code: `export interface RefreshLogRecord {
  phase: "attempt" | "persisted" | "declined" | "network";
  /** The verbatim GitHub \`error\` code on a decline (e.g. \`bad_refresh_token\`). */
  githubError?: string;
  /** A non-secret token-kind label (\`ghu_\`/\`gho_\`/…), never the token body. */
  tokenKind?: string;
}

export function tokenKind(token: string): string {
  return GITHUB_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? "token";
}`,
        },
        {
          kind: "requirement",
          name: "Token kind is an allowlisted prefix",
          delta: "added",
          text: 'The token-kind label in a record SHALL be only an allowlisted GitHub prefix (ghu_/gho_/…) or the fixed string "token" — never a slice of the token body.',
          status: "covered",
          coverage: { hunks: 1, tests: 3 },
          scenarios: [
            "WHEN a known prefix like `ghu_ABC` is labelled THEN tokenKind returns `ghu_`.",
            "WHEN an unrecognized value like `customerSecret_body` is labelled THEN tokenKind returns `token`, never a `customerSecret_` slice.",
          ],
        },
        {
          kind: "requirement",
          name: "Attempt is visible before the network call",
          delta: "added",
          text: "An `attempt` record SHALL be emitted at the start of the exchange, before the network call, so the attempt remains visible in daemon.log even if the process dies mid-refresh.",
          status: "partial",
          coverage: { hunks: 1, tests: 1 },
          scenarios: [
            "WHEN a refresh begins (proactive or reactive branch) THEN `attempt` is the first record emitted.",
            "WHEN the process dies after `attempt` but before an outcome THEN daemon.log still shows the attempt — asserted only by ordering; no crash-survival test proves the line flushed.",
          ],
        },
      ],
    },
    {
      id: "classification-retry",
      title: "failure-classification",
      badge: "added",
      gist: "Decline names its cause; network preserves the credential; the refresh layer adds no retry.",
      counts: "4 requirements · 3 covered · 1 partial",
      elements: [
        {
          kind: "requirement",
          name: "A decline is never a network failure",
          delta: "added",
          text: "When GitHub answers the refresh grant with HTTP 200 and an `error` field, the daemon SHALL log that error code verbatim, leave the stored credential untouched, and resolve to `token-invalid` — never classify a decline as network.",
          status: "covered",
          coverage: { hunks: 1, tests: 1 },
          scenarios: [
            'WHEN the exchange receives 200 with `{ error: "bad_refresh_token" }` THEN it emits `[attempt, declined]` with githubError = the code, writes nothing, and reports `token-invalid`.',
          ],
        },
        {
          kind: "requirement",
          name: "The refresh path owns no retry",
          delta: "added",
          text: "The refresh path SHALL NOT add a retry of its own; on a network error it SHALL emit a `network` record and propagate, calling the refresh exchange exactly once — retry ownership lives in the shared connect-resilient transport.",
          status: "covered",
          coverage: { hunks: 1, tests: 1 },
          refs: ["github-auth.test.ts"],
          scenarios: [
            "WHEN a refresh fails with `UND_ERR_CONNECT_TIMEOUT` THEN records are exactly `[attempt, network]` and refresh() is called exactly once.",
          ],
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.test.ts",
          startLine: 273,
          lang: "ts",
          highlightLines: [11, 12, 13, 14],
          code: `const refresh = vi.fn(() => Promise.reject(networkError));
const state = await resolveGitHubAuth({
  octokit: octokitFor({}),
  secretStore: store,
  refresh,
  now: () => NOW,
  log: (record) => records.push(record),
});
expect(state.reason).toBe("network");
// Exactly attempt then network — no retry phase, no extra records.
expect(records).toEqual([{ phase: "attempt" }, { phase: "network" }]);
// The stored credential is byte-unchanged: no write happened at all.
expect(store.writes).toEqual([]);
expect(store.current()).toEqual(original);
// The no-adapter-retry guarantee: the transport (not github-auth) owns retry.
expect(refresh).toHaveBeenCalledTimes(1);`,
        },
        {
          kind: "requirement",
          name: "Network failure preserves the credential",
          delta: "added",
          text: "A refresh that fails for a network reason SHALL leave the stored credential byte-identical and surface reason `network`, because an unreached GitHub says nothing about the credential's validity.",
          status: "covered",
          coverage: { hunks: 1, tests: 2 },
          scenarios: [
            "WHEN a refresh degrades to `network` THEN store.writes is empty and store.current() equals the original credential.",
            "WHEN a later attempt runs once GitHub is reachable THEN the untouched credential can still be refreshed.",
          ],
        },
        {
          kind: "requirement",
          name: "The transport retries once, replay-safely",
          delta: "added",
          text: "The shared GitHub transport SHALL absorb a connect-phase blip by retrying exactly once, replay-safely, and SHALL NOT replay a post-send failure that could double a rotation.",
          status: "partial",
          coverage: { hunks: 1, tests: 0 },
          scenarios: [
            "WHEN a refresh's request fails connect-phase and the retry would succeed THEN the transport retries once, the rotated pair persists, and resolution is `ok`.",
          ],
        },
      ],
    },
    {
      id: "field-proof",
      title: "github-auth · field proof (lancelot)",
      badge: "modified",
      gist: "Observe a refresh succeed-and-rotate live — deferred to a manual run against the real account.",
      counts: "1 requirement · 0 covered · 1 open",
      elements: [
        {
          kind: "callout",
          tone: "warn",
          text: 'Listed in the PR body under "Not in this PR": the Wave 6 field proof needs the real lancelot account, so the diff carries no code or test for it — tasks 6.1 and 6.2 remain unchecked.',
        },
        {
          kind: "requirement",
          name: "One real refresh observed in the field",
          delta: "modified",
          text: "The daemon SHALL be observed to refresh a real credential successfully at least once on lancelot — reading a `persisted` record from daemon.log (or capturing the verbatim decline code) as the first field confirmation the mechanism works.",
          status: "unimplemented",
          coverage: { hunks: 0, tests: 0 },
          scenarios: [
            "WHEN the daemon bundle runs on lancelot and a project.detail forces a refresh THEN daemon.log shows a `persisted` record, or the `declined` githubError code is captured.",
          ],
        },
      ],
    },
    {
      id: "tasks",
      title: "Tasks",
      gist: "11 of 13 done — the two open tasks are the lancelot field proof.",
      elements: [
        {
          kind: "task-progress",
          source: "openspec/changes/observe-github-token-refresh/tasks.md",
          groups: [
            { label: "1 · The secret-free record type", done: 3, total: 3 },
            { label: "2 · Wire the injected logger", done: 3, total: 3 },
            { label: "3 · Classification + no-retry", done: 3, total: 3 },
            { label: "5 · Tests + gates", done: 2, total: 2 },
            { label: "6 · Field proof on lancelot", done: 0, total: 2 },
          ],
        },
      ],
    },
  ],
}
