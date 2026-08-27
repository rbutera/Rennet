import type { LensBoard } from "@rennet/protocol";
import { board, codeRef, finding, message, prose, section } from "./helpers";

const BOTH_AGREE = [
  { model: "claude", agree: 1, total: 1 },
  { model: "codex", agree: 1, total: 1 },
];

// Flagged lens — exclusively what is currently flagged. Two medium findings, one
// carrying a human `discuss` thread anchored to the cited code (its text is
// transcript-side, Reconciliation 5).
export const flaggedBoard: LensBoard = board("flagged", "gen1", "flagged-gen1", [
  section(
    "flagged-medium",
    "Medium",
    "A refresh can log `attempt` and no outcome, and a post-send reset is reported as if the token is definitely untouched.",
    [
      finding("f1", {
        severity: "medium",
        status: "open",
        concurrence: BOTH_AGREE,
        code: ["cr-f1"],
        concern:
          "`refreshAndPersist` logs `attempt` at the start of the exchange, then a terminal record on only three routes (`declined`, `network`, `persisted`). Two reachable exits — a non-decline exchange error, and a persistence failure after a successful rotation — emit `attempt` and nothing after it, leaving daemon.log reading the same as a process that died mid-exchange.\n\n**Fix:** write a secret-free terminal record on every exit.",
      }),
      finding("f2", {
        severity: "medium",
        status: "open",
        concurrence: BOTH_AGREE,
        code: ["cr-f2"],
        concern:
          "GitHub can accept the refresh POST and rotate the pair, then reset the response connection with `ECONNRESET`. That code is in `NETWORK_CODES`, so the copy reads 'Your connection and token are untouched' — but the token is touched: the stored refresh token is now dead. Skipping the retry is right; the reporting is wrong.\n\n**Fix:** represent a post-send network failure as an unknown outcome rather than asserting the credential survived.",
      }),
      message("f2-discuss", {
        role: "discuss",
        codeRef: "cr-f2",
        quoteTarget: "f2",
        quote: "the copy reads 'Your connection and token are untouched'",
      }),
    ],
    {
      refs: [
        codeRef("cr-f1", "packages/adapters/src/github-auth.ts", 244, 266),
        codeRef("cr-f2", "packages/adapters/src/github-auth.ts", 295),
      ],
    },
  ),
  section(
    "flagged-cleared",
    "Checked and Cleared",
    "Four concerns verified safe: the retry allowlist gap, secret-safety, log injection, the account lock.",
    [
      prose(
        "cleared-prose",
        "The connect-phase retry allowlist omits definite pre-send codes (`ECONNREFUSED`, `EHOSTUNREACH`, `ENETDOWN`); their absence only means the one-shot retry does not fire, and the failure still degrades to an honest `network` state with the credential untouched. Secret-safety holds: `RefreshLogRecord` has no field that can carry a token, and the sink concatenates only `phase`, `githubError`, and `tokenKind`. The account lock cannot jam — it resets via `catch(() => undefined)`.",
      ),
    ],
  ),
]);

/**
 * Flagged, generation 2 (after round 1). Delta-aware: the post-send copy finding
 * carries forward as still-open (`reworked`), a beyond-the-asks change is `new`, and
 * generation 1 freezes as a folded drill-down. What the round ADDRESSED is not here —
 * that account lives at the end of Sequence.
 */
export const flaggedGen2Board: LensBoard = board("flagged", "gen2", "flagged-gen2", [
  section(
    "g2-open",
    "Still Open",
    "The post-send network copy is now honest about uncertainty, but the message still needs a wording pass.",
    [
      finding("f2", {
        severity: "medium",
        status: "addressed",
        concurrence: BOTH_AGREE,
        code: ["cr-f2"],
        concern:
          "This round stopped `resolveGitHubAuth` from asserting that the credential survived a post-send reset — it now classifies that case as an unknown outcome rather than `network`-with-untouched-copy. The user-facing copy string still reads as reassurance, so the classification is fixed and the wording is not.\n\n**Fix:** replace the 'connection and token are untouched' copy with an unknown-state message on the post-send path.",
      }),
    ],
    {
      delta: "reworked",
      refs: [codeRef("cr-f2", "packages/adapters/src/github-auth.ts", 295)],
    },
  ),
  section(
    "g2-beyond",
    "Beyond the Asks",
    "The round tightened the exchange-error tests without being asked.",
    [
      prose(
        "g2-beyond-prose",
        "`github-auth.test.ts` gained a case for the neither-decline-nor-network exchange error. It asserts the new `[attempt, failed]` sequence and no credential write. Not in the asks — the worker added it while closing the first finding, and it is the test that would have caught the gap.",
      ),
    ],
    { delta: "new" },
  ),
  section("g2-gen1", "Generation 1 · Round 1 · Frozen", "The first read, before the round.", [
    prose(
      "g2-frozen-1",
      "**A refresh can log `attempt` and never a terminal outcome.** Two reachable exits left daemon.log stopped at `phase=attempt`. Closed this round — the account is at the end of Sequence.",
    ),
    prose(
      "g2-frozen-2",
      "**A post-send connection reset reads as if the credential is untouched.** `ECONNRESET` matches `isGitHubNetworkError`, so the copy asserted the token survived when a successful send had already rotated it. Partly addressed this round, copy pass still open.",
    ),
  ]),
]);
