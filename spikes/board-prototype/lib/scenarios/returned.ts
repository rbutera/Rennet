/**
 * `returned` (W1b) — round 1 came back. Reached by dispatching the round from
 * `rounds` (watched live, then greeted by the round report) or by the
 * `?scenario=returned` deep link. The boards are generation 2 (delta-aware,
 * generation 1 frozen as a drill-down); the PR lane is ripe. See SCENARIOS.md.
 */

import type { Scenario, RoundReturn } from "./index"
import type { TurnData } from "@/lib/conversation-data"
import { roundsScenario, PR_438_TITLE, PR_438_BODY } from "./rounds"
import { designBoard } from "@/lib/fixtures/design"
import { sequenceGen2Board } from "@/lib/fixtures/sequence"
import { decisionsBoard } from "@/lib/fixtures/decisions"
import { noiseBoard } from "@/lib/fixtures/noise"
import { flaggedGen2Board } from "@/lib/fixtures/flagged-gen2"

export const returnedRound: RoundReturn = {
  number: 1,
  when: "09:47",
  greeting: "Round 1 is back. I applied both asks on a detached worktree, the gate came back green (14 projects), and re-drafted the boards against what changed. Here is what the round did.",
  items: [
    {
      status: "addressed",
      ask: "Log an outcome for every refresh attempt",
      note: "`refreshAndPersist` now writes a terminal record on both silent exits — the exchange error and the persistence failure. daemon.log no longer stops at `attempt`.",
      anchor: { path: "packages/adapters/src/github-auth.ts", line: 260 },
    },
    {
      status: "partial",
      ask: "Report the post-send failure as an unknown outcome",
      note: "The classification is fixed — a post-send reset is no longer reported as `network`-with-untouched — but the user-facing copy string still reads as reassurance. Left for the next round.",
      anchor: { path: "packages/adapters/src/github-auth.ts", line: 295 },
    },
    {
      status: "beyond",
      ask: "Test tightening (not asked)",
      note: "Added a `github-auth.test.ts` case for the neither-decline-nor-network exchange error — the test that would have caught the first finding.",
    },
  ],
  triggers: [
    "ask · log an outcome for every refresh attempt",
    "ask · report the post-send failure as unknown",
    "successor account · 1 addressed, 1 partial, 1 beyond",
  ],
}

const returnTurns: TurnData[] = [
  {
    id: "rr-dispatch",
    speaker: "user",
    time: "09:46",
    paragraphs: ["Dispatch it."],
  },
  {
    id: "rr-back",
    speaker: "orchestrator",
    time: "09:47",
    paragraphs: [
      "Round 1 is back — detached worktree, both asks applied, `pnpm check` green across 14 projects, two commits. The summary is on the surface; the boards are re-drafted as generation 2, with the first read frozen underneath. The pull request lane is ripe whenever you want to open it.",
    ],
  },
]

export const returnedScenario: Scenario = {
  id: "returned",
  projectId: "p1",
  session: {
    id: "s2",
    title: "Token refresh before the PR",
    time: "1h",
    target: "your-branch",
  },
  cta: "Continue",
  transcript: [...roundsScenario.transcript, ...returnTurns],
  boards: {
    design: designBoard,
    sequence: sequenceGen2Board,
    decisions: decisionsBoard,
    flagged: flaggedGen2Board,
    noise: noiseBoard,
  },
  handoff: {
    mode: "rounds",
    pr: { title: PR_438_TITLE, body: PR_438_BODY, ready: true },
  },
  rounds: [returnedRound],
}
