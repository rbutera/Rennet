/**
 * `teammate` (W3) — write the review on a teammate PR. Currently wraps the
 * pre-scenario demo content (Priya's auth refactor transcript + the change-A
 * lens fixtures); build step 5 replaces both with a real change-B pipeline
 * run and a grounded transcript (see SCENARIOS.md).
 */

import type { Scenario } from "./index"
import { turns } from "@/lib/conversation-data"
import { designBoard } from "@/lib/fixtures/design"
import { sequenceBoard } from "@/lib/fixtures/sequence"
import { decisionsBoard } from "@/lib/fixtures/decisions"
import { flaggedBoard } from "@/lib/fixtures/flagged"
import { noiseBoard } from "@/lib/fixtures/noise"

export const teammateScenario: Scenario = {
  id: "teammate",
  projectId: "p1",
  session: {
    id: "s1",
    title: "Review Priya's auth refactor",
    time: "now",
    active: true,
    target: "teammate-pr",
    targetState: "needs-you",
  },
  cta: "Write Review",
  transcript: turns,
  boards: {
    design: designBoard,
    sequence: sequenceBoard,
    decisions: decisionsBoard,
    flagged: flaggedBoard,
    noise: noiseBoard,
  },
  handoff: { mode: "post-review", prLabel: "PR #434" },
}
