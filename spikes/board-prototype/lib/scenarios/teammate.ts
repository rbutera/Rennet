/**
 * `teammate` (W3) — write the review on a teammate PR. Change B: the REAL
 * merged PR #439 (daemon-in-distro runtime), boards drafted by the actual
 * lens pipeline (dual Flagged seats, adversarial verification, unslop pass),
 * framed as authored by Priya (SCENARIOS.md: the one staged element).
 */

import type { Scenario } from "./index"
import { teammateTranscript } from "./teammate-transcript"
import { designBoardB } from "@/lib/fixtures/b/design"
import { sequenceBoardB } from "@/lib/fixtures/b/sequence"
import { decisionsBoardB } from "@/lib/fixtures/b/decisions"
import { flaggedBoardB } from "@/lib/fixtures/b/flagged"
import { noiseBoardB } from "@/lib/fixtures/b/noise"

export const teammateScenario: Scenario = {
  id: "teammate",
  projectId: "p1",
  session: {
    id: "s1",
    title: "Review Priya's #439",
    time: "now",
    active: true,
    target: "teammate-pr",
    targetState: "needs-you",
  },
  cta: "Write Review",
  transcript: teammateTranscript,
  boards: {
    design: designBoardB,
    sequence: sequenceBoardB,
    decisions: decisionsBoardB,
    flagged: flaggedBoardB,
    noise: noiseBoardB,
  },
  handoff: { mode: "post-review", prLabel: "PR #439" },
}
