/**
 * Flagged, generation 2 (after round 1). Delta-aware: the missing-outcome
 * finding is marked addressed, the post-send copy finding carries forward as
 * still-open, and generation 1 freezes as a folded drill-down.
 *
 * Chronology (SCENARIOS.md): issue #478's fix has NOT landed on real rennet
 * (checked at build — #478 is open), so the addressed block carries a literal
 * `code` element (the fixture-convenience kind) rather than hydrating real
 * lines. Still-open and carried-forward blocks hydrate as before.
 */

import type { LensBoard } from "@/lib/lens-data"

export const flaggedGen2Board: LensBoard = {
  lens: "flagged",
  title: "Flagged",
  intro: "Generation 2 · round 1",
  sections: [
    {
      id: "g2-addressed",
      title: "Addressed this round",
      gist: "Every refresh exit now writes a terminal record — the missing-outcome finding is closed.",
      counts: "1 finding",
      elements: [
        {
          kind: "prose",
          text: "`refreshAndPersist` now writes a secret-free terminal record on the two exits that previously left only `attempt`: the non-decline exchange error and the post-rotation persistence failure. daemon.log no longer stops at `phase=attempt`, so a crash and a real outcome are finally distinguishable — the exact ambiguity this change set out to remove. Raised as issue #478; the round applied the fix on the branch.",
        },
        {
          kind: "code",
          path: "packages/adapters/src/github-auth.ts",
          startLine: 258,
          lang: "ts",
          highlightLines: [260, 261, 265, 266],
          code: `  } catch (error) {
    if (error instanceof GitHubOAuthDeclined) { /* declined — already logged */ throw error }
    if (isGitHubNetworkError(error)) {
      log({ phase: "network", tokenKind: tokenKind(current) })
    } else {
      // exchange error that is neither decline nor network
      log({ phase: "failed", tokenKind: tokenKind(current) })
    }
    throw error
  }`,
        },
        {
          kind: "callout",
          tone: "info",
          text: "The persistence-failure exit gets the same treatment: a `failed` record is written before the throw escapes, so a rotation the store dropped is no longer a silent dead session.",
        },
      ],
    },
    {
      id: "g2-open",
      title: "Still open",
      gist: "The post-send network copy is now honest about uncertainty, but the message still needs a wording pass.",
      counts: "1 finding · partial",
      elements: [
        {
          kind: "finding",
          id: "f2",
          title: "A post-send connection reset is reported as if the credential is definitely untouched",
          severity: "medium",
          agreement: { claude: true, codex: true },
          body: "The round stopped `resolveGitHubAuth` from asserting the credential survived a post-send reset — it now classifies that case as an unknown outcome rather than `network`-with-untouched-copy. What is not done: the user-facing copy string still reads as reassurance. Partial — the classification is fixed, the wording is not.",
          fix: "Replace the 'connection and token are untouched' copy with an unknown-state message on the post-send path.",
          anchor: { path: "packages/adapters/src/github-auth.ts", line: 295 },
        },
      ],
    },
    {
      id: "g2-beyond",
      title: "Beyond the asks",
      startFolded: true,
      gist: "The round tightened the exchange-error tests without being asked.",
      counts: "1 change",
      elements: [
        {
          kind: "prose",
          text: "`github-auth.test.ts` gained a case for the neither-decline-nor-network exchange error, asserting the new `[attempt, failed]` sequence and no credential write. Not in the asks — the worker added it while closing the first finding, and it is the test that would have caught the gap.",
        },
      ],
    },
    {
      id: "g2-gen1",
      title: "Generation 1 · round 1 · frozen",
      startFolded: true,
      gist: "The first read, before the round — kept as a drill-down.",
      counts: "2 findings",
      elements: [
        {
          kind: "prose",
          text: "**A refresh can log `attempt` and never a terminal outcome** — on a non-decline exchange error and on a persistence failure after a successful rotation, two reachable exits left daemon.log stopped at `phase=attempt`. Closed this round (above).",
        },
        {
          kind: "prose",
          text: "**A post-send connection reset is reported as if the credential is untouched** — `ECONNRESET` matches `isGitHubNetworkError`, so the copy asserted the token survived when a successful send had already rotated it. Partly addressed this round; copy pass still open.",
        },
      ],
    },
  ],
}
