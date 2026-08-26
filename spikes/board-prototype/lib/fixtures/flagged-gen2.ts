/**
 * Flagged, generation 2 (after round 1). Delta-aware: the post-send copy
 * finding carries forward as still-open, generation 1 freezes as a folded
 * drill-down. What the round ADDRESSED is not here — Flagged is exclusively
 * what is currently flagged; the round's addressed account lives at the end
 * of Sequence (`round1AddressedSection` in fixtures/sequence.ts).
 */

import type { LensBoard } from "@/lib/lens-data"

export const flaggedGen2Board: LensBoard = {
  lens: "flagged",
  title: "Flagged",
  intro: "Generation 2 · round 1",
  sections: [
    {
      id: "g2-open",
      title: "Still Open",
      delta: "reworked",
      gist: "The post-send network copy is now honest about uncertainty, but the message still needs a wording pass.",
      counts: "1 finding · partial",
      elements: [
        {
          kind: "finding",
          id: "f2",
          title: "After a post-send connection reset, the copy still tells the user the credential is untouched",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body: "This round stopped `resolveGitHubAuth` from asserting that the credential survived a post-send reset. It now classifies that case as an unknown outcome rather than `network`-with-untouched-copy. The user-facing copy string still reads as reassurance, so the classification is fixed and the wording is not.",
          fix: "Replace the 'connection and token are untouched' copy with an unknown-state message on the post-send path.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 295 },
        },
      ],
    },
    {
      id: "g2-beyond",
      title: "Beyond the Asks",
      delta: "new",
      gist: "The round tightened the exchange-error tests without being asked.",
      counts: "1 change",
      elements: [
        {
          kind: "prose",
          text: "`github-auth.test.ts` gained a case for the neither-decline-nor-network exchange error. It asserts the new `[attempt, failed]` sequence and no credential write. Not in the asks. The worker added it while closing the first finding, and it is the test that would have caught the gap.",
        },
      ],
    },
    {
      id: "g2-gen1",
      title: "Generation 1 · Round 1 · Frozen",
      startFolded: true,
      gist: "The first read, before the round.",
      counts: "2 findings",
      elements: [
        {
          kind: "prose",
          text: "**A refresh can log `attempt` and never a terminal outcome.** Two reachable exits left daemon.log stopped at `phase=attempt`.\n\n- A non-decline exchange error.\n- A persistence failure after a successful rotation.\n\nClosed this round — the account is at the end of Sequence.",
        },
        {
          kind: "prose",
          text: "**A post-send connection reset reads as if the credential is untouched.** `ECONNRESET` matches `isGitHubNetworkError`, so the copy asserted the token survived when a successful send had already rotated it. Partly addressed this round, copy pass still open.",
        },
      ],
    },
  ],
}
