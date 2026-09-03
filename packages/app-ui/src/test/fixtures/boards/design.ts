import type { LensBoard } from "@rennet/protocol";
import { board, callout, codeRef, decision, prose, requirement, section } from "./helpers";

// Design lens — PR #438 "observe the GitHub token refresh, drop the unsafe retry".
// The spike's spec-header / what-changes / capability-grid / task-progress composites
// are re-expressed here through section titles, `prose`, and `requirement` (Recon. 4).

const CHANGE = "openspec/changes/github-token-refresh-reliability";

/** Generation 1 — the implemented Design board (diff exists, coverage real). */
export const designBoard: LensBoard = board("design", "gen1", "design-gen1", [
  section(
    "change",
    "The Change",
    "github-token-refresh-reliability · 2 new capabilities · 1 modified · tasks 11/13.",
    [
      prose(
        "change-why",
        "The token's lifetime was never the bug. Renewal was silent, so a failed refresh looked identical to a missing credential, and the refresh layer's own retry could double a rotation. Every refresh now writes a secret-free log record, and the shared transport owns retry.",
      ),
    ],
  ),
  section(
    "proposal",
    "Proposal",
    "Silent renewal made every auth failure ambiguous; observe each refresh, classify its failures, move retry out.",
    [
      prose(
        "proposal-body",
        "Support traffic could not tell an expired credential from a failed rotation from an unreachable GitHub. All three surfaced as the same re-auth prompt.\n\n- Make the refresh exchange observable, one record per attempt and outcome.\n- Classify failures precisely, decline against network.\n- Remove the refresh layer's own retry, whose replay of a post-send failure could double a rotation.",
      ),
    ],
  ),
  section(
    "design",
    "Design",
    "Injected logger over a global sink; type-level secret-safety over redaction; the transport owns retry.",
    [
      decision("d-logger", {
        statement: "Records flow through an injected logger, not a global sink",
        why: "The daemon decides where records land, daemon.log today. Tests capture records as plain values instead of scraping log output.",
        evidence: ["cr-logger"],
        alternatives: ["module-level logger singleton", "event-emitter the daemon subscribes to"],
      }),
      decision("d-record", {
        statement:
          "The record type has no field that can hold a token, so secret-safety is a property of the type",
        why: "A serialize-time redaction pass can miss a newly added field. A type with no secret-shaped field makes the leak unrepresentable, and the sentinel-token test proves it end to end.",
        evidence: ["cr-record"],
        alternatives: ["redaction allowlist at serialization", "log-scrubbing middleware"],
      }),
      decision("d-retry", {
        statement: "Retry ownership moves to the shared connect-resilient transport",
        why: "The transport can tell a connect-phase blip, safe to replay, from a post-send failure whose replay could double a rotation. The refresh path cannot, so it calls the exchange exactly once.",
        evidence: ["cr-retry"],
        alternatives: ["adapter-level retry with an idempotency key"],
      }),
    ],
    {
      refs: [
        codeRef("cr-logger", "packages/adapters/src/github-auth.ts", 431),
        codeRef("cr-record", "packages/adapters/src/github-auth.ts", 407),
        codeRef("cr-retry", "packages/adapters/src/github-auth.test.ts", 288),
      ],
    },
  ),
  section(
    "observability",
    "refresh-observability",
    "Every refresh attempt lands one secret-free line in daemon.log, by construction.",
    [
      prose(
        "obs-intro",
        "The refresh exchange emitted zero logs before this change, so a field failure could only be inferred. The daemon now records each attempt and its outcome through an injected logger, using a record type with no field able to hold a credential.",
      ),
      requirement("req-recorded", {
        shall:
          "The daemon SHALL record every credential refresh attempt and its outcome to daemon.log through an injected logger, so a field failure is observed rather than inferred.",
        trace: ["cr-record"],
      }),
      requirement("req-nosecret", {
        shall:
          "A RefreshLogRecord SHALL carry no token, refresh token, or secret field, so a credential cannot be logged even by mistake — enforced by the type, not a review promise.",
        trace: ["cr-record"],
      }),
      requirement("req-attempt", {
        shall:
          "An `attempt` record SHALL be emitted at the start of the exchange, before the network call, so the attempt remains visible even if the process dies mid-refresh.",
      }),
    ],
    { refs: [codeRef("cr-record", "packages/adapters/src/github-auth.ts", 407, 415)] },
  ),
  section(
    "field-proof",
    "github-auth · Field Proof (lancelot)",
    "Watch a live refresh succeed and rotate, deferred to a manual run against the real account.",
    [
      callout(
        "fp-callout",
        "warn",
        'The proposal lists this under "Not in this PR". The Wave 6 field proof needs the real lancelot account, so the diff carries no code or test for it, and tasks 6.1 and 6.2 remain unchecked.',
      ),
      requirement("req-field", {
        shall:
          "The daemon SHALL be observed to refresh a real credential successfully at least once on lancelot — a `persisted` record read from daemon.log is the first field confirmation.",
      }),
    ],
  ),
  section("tasks", "Tasks", "11 of 13 done. The two open tasks are the lancelot field proof.", [
    prose(
      "tasks-body",
      "11 of 13 tasks done. The secret-free record type, the injected logger, classification + no-retry, and the tests + gates are complete; the two open tasks are the lancelot field proof (6.1, 6.2).",
    ),
  ]),
]);

/**
 * Generation 0 — the propose-time frozen Design board (the drill-down target). No
 * diff, no coverage: tasks 0/13, every requirement absent-coverage (`gap`), decision
 * evidence cites the design.md spec markdown rather than hydrated code.
 */
export const designGen0Board: LensBoard = board("design", "gen0", "design-gen0", [
  section(
    "change",
    "The Change",
    "github-token-refresh-reliability · 2 new capabilities · 1 modified · tasks 0/13.",
    [
      prose(
        "change-why",
        "The token's lifetime was never the bug. Renewal was silent. This change makes every refresh observable through a secret-free log record, and moves retry ownership to the shared transport. Nothing is implemented yet.",
      ),
    ],
  ),
  section(
    "design",
    "Design",
    "Injected logger over a global sink; type-level secret-safety over redaction; the transport owns retry.",
    [
      decision("d-logger", {
        statement: "Records flow through an injected logger, not a global sink",
        why: "The daemon decides where records land (daemon.log today), and tests capture records as plain values instead of scraping log output.",
        evidence: ["cr-design-md"],
        alternatives: ["module-level logger singleton", "event-emitter the daemon subscribes to"],
      }),
    ],
    { refs: [codeRef("cr-design-md", `${CHANGE}/design.md`, 23)] },
  ),
  section(
    "tasks",
    "Tasks",
    "0 of 13 done. Nothing is implemented yet; the change is still a proposal.",
    [prose("tasks-body", "0 of 13 tasks done. The change is still a proposal.")],
  ),
]);
