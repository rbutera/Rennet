/**
 * Design generation 0 — the propose-time Design board for change A, derived
 * from `design.ts` (the same change's generation 1). This is the frozen board
 * a 2-day-old session recorded when `openspec propose` had run and nothing was
 * implemented: the spec artifacts exist, but there is no diff, no coverage, no
 * code to cite.
 *
 * What changes from generation 1 (SCENARIOS.md · `propose` W2):
 * - tasks 0/13; every task-progress bar is 0/N.
 * - No coverage chips and no refs on requirements — coverage is a relation to
 *   an implementation patchset, and none exists; absent is honestly absent.
 * - No `code`/`code-ref` elements — there is no diff to hydrate. Decision
 *   evidence cites the real design.md (spec markdown, hydrates via /api/source).
 * - The what-changes spine and impact box stay: they derive from the
 *   proposal's declared deltas, not from hunks.
 * - The `.openspec.yaml` scaffold stamp lives in `skippedHunks` (R22 — data,
 *   nothing rendered).
 */

import type { LensBoard } from "@/lib/lens-data"

const CHANGE = "openspec/changes/github-token-refresh-reliability"

export const designGen0Board: LensBoard = {
  lens: "design",
  title: "Design · GitHub token refresh, observed",
  wide: true,
  // R22: the scaffold stamp is Noise's lane; with no Noise board at propose
  // stage it rides here as coverage data. Never rendered.
  skippedHunks: [
    {
      path: `${CHANGE}/.openspec.yaml`,
      reason: "OpenSpec scaffold stamp — Noise's lane; no Noise board exists pre-implementation.",
    },
  ],
  sections: [
    {
      id: "change",
      title: "The change",
      gist: "github-token-refresh-reliability · 2 new capabilities · 1 modified · tasks 0/13.",
      elements: [
        {
          kind: "spec-header",
          change: "github-token-refresh-reliability",
          source: CHANGE,
          format: "OpenSpec",
          counts: { added: 2, modified: 1 },
          tasks: { done: 0, total: 13 },
          why: "The token's lifetime was never the bug. Renewal was silent, so a failed refresh looked identical to a missing credential, and the refresh layer's own retry could double a rotation. This change makes every refresh observable through a secret-free log record, and moves retry ownership to the shared transport.",
          artifacts: [
            { label: "proposal.md", sectionId: "proposal" },
            { label: "design.md", sectionId: "design" },
            { label: "specs · 3 deltas", sectionId: "observability" },
            { label: "tasks.md", sectionId: "tasks" },
          ],
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
      id: "proposal",
      title: "Proposal",
      source: "proposal.md",
      gist: "Silent renewal made every auth failure ambiguous; observe each refresh, classify its failures, move retry out.",
      elements: [
        {
          kind: "prose",
          text: "Support traffic could not tell an expired credential from a failed rotation, or either one from GitHub being unreachable. All three surfaced as the same re-auth prompt. The proposal answers with three changes.\n\n- Make the refresh exchange observable, one log record per attempt and outcome.\n- Classify each failure as a decline or a network error.\n- Remove the refresh layer's own retry, whose replay of a post-send failure could double a rotation.",
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
            "- packages/adapters only. No new package, no dependency change.\n- The logger is injected, so the daemon owns where records land (daemon.log).\n- Out of scope: the Wave 6 field proof on lancelot.",
        },
      ],
    },
    {
      id: "design",
      title: "Design",
      source: "design.md",
      gist: "Injected logger over a global sink; type-level secret-safety over redaction; the transport owns retry.",
      counts: "3 decisions",
      elements: [
        {
          kind: "decision",
          statement: "Records flow through an injected logger, not a global sink",
          why: "The daemon decides where records land (daemon.log today), and tests capture records as plain values instead of scraping log output.",
          inferred: false,
          alternatives: ["module-level logger singleton", "event-emitter the daemon subscribes to"],
          evidence: [{ path: `${CHANGE}/design.md`, line: 23 }],
        },
        {
          kind: "decision",
          statement: "The record type carries no field that can hold a token, so secret-safety is type-level",
          why: "A serialize-time redaction pass can miss a newly added field. A type with no secret-shaped field makes the leak unrepresentable, and the sentinel-token test proves it end to end.",
          inferred: false,
          alternatives: ["redaction allowlist at serialization", "log-scrubbing middleware"],
          evidence: [{ path: `${CHANGE}/design.md`, line: 25 }],
        },
        {
          kind: "decision",
          statement: "Retry ownership moves to the shared connect-resilient transport",
          why: "The transport can tell a connect-phase blip, safe to replay, from a post-send failure whose replay could double a rotation. The refresh path cannot, so it calls the exchange exactly once.",
          inferred: false,
          alternatives: ["adapter-level retry with an idempotency key"],
          evidence: [{ path: `${CHANGE}/design.md`, line: 27 }],
        },
      ],
    },
    {
      id: "observability",
      title: "refresh-observability",
      badge: "added",
      source: "specs/refresh-observability/spec.md",
      gist: "Every refresh attempt lands one secret-free line in daemon.log, by construction.",
      counts: "4 requirements",
      elements: [
        {
          kind: "prose",
          text: "The refresh exchange emitted zero logs before this change, so a field failure could only be inferred and no one had ever confirmed a success. The change requires the daemon to record each attempt and its outcome through an injected logger, using a record type that has no field able to hold a credential.",
        },
        {
          kind: "requirement",
          name: "Every refresh is recorded",
          delta: "added",
          text: "The daemon SHALL record every credential refresh attempt and its outcome — persisted, declined, or network — to daemon.log through an injected logger, so a field failure is observed rather than inferred.",
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
          scenarios: [
            "WHEN any refresh record is written THEN it contains no access token, refresh token, or secret value.",
            "WHEN a full refresh (attempt → persisted) runs with sentinel tokens THEN neither the old nor the rotated token string appears in any serialized record.",
          ],
        },
        {
          kind: "requirement",
          name: "Token kind is an allowlisted prefix",
          delta: "added",
          text: 'The token-kind label in a record SHALL be only an allowlisted GitHub prefix (ghu_/gho_/…) or the fixed string "token" — never a slice of the token body.',
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
          scenarios: [
            "WHEN a refresh begins (proactive or reactive branch) THEN `attempt` is the first record emitted.",
            "WHEN the process dies after `attempt` but before an outcome THEN daemon.log still shows the attempt.",
          ],
        },
      ],
    },
    {
      id: "classification-retry",
      title: "failure-classification",
      badge: "added",
      source: "specs/failure-classification/spec.md",
      gist: "Decline names its cause; network preserves the credential; the refresh layer adds no retry.",
      counts: "4 requirements",
      elements: [
        {
          kind: "requirement",
          name: "A decline is never a network failure",
          delta: "added",
          text: "When GitHub answers the refresh grant with HTTP 200 and an `error` field, the daemon SHALL log that error code verbatim, leave the stored credential untouched, and resolve to `token-invalid` — never classify a decline as network.",
          scenarios: [
            'WHEN the exchange receives 200 with `{ error: "bad_refresh_token" }` THEN it emits `[attempt, declined]` with githubError = the code, writes nothing, and reports `token-invalid`.',
          ],
        },
        {
          kind: "requirement",
          name: "The refresh path owns no retry",
          delta: "added",
          text: "The refresh path SHALL NOT add a retry of its own; on a network error it SHALL emit a `network` record and propagate, calling the refresh exchange exactly once — retry ownership lives in the shared connect-resilient transport.",
          scenarios: [
            "WHEN a refresh fails with `UND_ERR_CONNECT_TIMEOUT` THEN records are exactly `[attempt, network]` and refresh() is called exactly once.",
          ],
        },
        {
          kind: "requirement",
          name: "Network failure preserves the credential",
          delta: "added",
          text: "A refresh that fails for a network reason SHALL leave the stored credential byte-identical and surface reason `network`, because an unreached GitHub says nothing about the credential's validity.",
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
      source: "specs/github-auth/spec.md",
      gist: "Observe a refresh succeed and rotate live, deferred to a manual run against the real account.",
      counts: "1 requirement",
      elements: [
        {
          kind: "callout",
          tone: "warn",
          text: 'The proposal defers this under "Not in this change". The Wave 6 field proof needs the real lancelot account, so no code or test lands for it here, and tasks 6.1 and 6.2 stay open for a manual run.',
        },
        {
          kind: "requirement",
          name: "One real refresh observed in the field",
          delta: "modified",
          text: "The daemon SHALL be observed to refresh a real credential successfully at least once on lancelot — reading a `persisted` record from daemon.log (or capturing the verbatim decline code) as the first field confirmation the mechanism works.",
          scenarios: [
            "WHEN the daemon bundle runs on lancelot and a project.detail forces a refresh THEN daemon.log shows a `persisted` record, or the `declined` githubError code is captured.",
          ],
        },
      ],
    },
    {
      id: "tasks",
      title: "Tasks",
      source: "tasks.md",
      gist: "0 of 13 done. Nothing is implemented yet; the change is still a proposal.",
      elements: [
        {
          kind: "task-progress",
          groups: [
            { label: "1 · The secret-free record type", done: 0, total: 3 },
            { label: "2 · Wire the injected logger", done: 0, total: 3 },
            { label: "3 · Classification + no-retry", done: 0, total: 3 },
            { label: "5 · Tests + gates", done: 0, total: 2 },
            { label: "6 · Field proof on lancelot", done: 0, total: 2 },
          ],
        },
      ],
    },
  ],
}
