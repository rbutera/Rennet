/**
 * `propose` (W2) — spec only, Design lens alone. The 2-day-old session on
 * change A's branch, recorded when `openspec propose` had run and nothing was
 * implemented (SCENARIOS.md · `propose`). Boards carry the Design generation-0
 * board only; the view switcher shows Design + Diff automatically (absent lens
 * = absent segment). Continue opens the own-branch rounds hand-off, whose PR
 * lane is thin and honest about it (ready: false).
 *
 * Grounded in the real openspec change
 * `openspec/changes/github-token-refresh-reliability/` — every citation in the
 * transcript resolves against the checkout via /api/source.
 */

import type { Scenario } from "./index"
import type { TurnData } from "@/lib/conversation-data"
import { FileText, FolderSearch, GitBranch, Search } from "lucide-react"
import { designGen0Board } from "@/lib/fixtures/design-gen0"

const transcript: TurnData[] = [
  {
    id: "pr0a",
    speaker: "user",
    time: "2d ago",
    paragraphs: ["I've drafted the token-refresh proposal — review the spec before anything gets built."],
  },
  {
    id: "pr0b",
    speaker: "orchestrator",
    time: "2d ago",
    preface: [
      {
        kind: "action",
        id: "pr-p0",
        label: "Read the working tree",
        detail: "fix/token-refresh-observability · no diff yet",
        state: "done",
        icon: GitBranch,
      },
      {
        kind: "action",
        id: "pr-p1",
        label: "Discovered the OpenSpec change",
        detail: "github-token-refresh-reliability",
        state: "done",
        icon: FolderSearch,
      },
      {
        kind: "action",
        id: "pr-p2",
        label: "Read the spec artifacts",
        detail: "proposal.md, design.md, specs · 3 deltas, tasks.md",
        state: "done",
        icon: FileText,
      },
      {
        kind: "action",
        id: "pr-p3",
        label: "Mapped tasks",
        detail: "0/13 done — nothing implemented",
        state: "done",
        icon: Search,
      },
    ],
    paragraphs: [
      "The proposal is drafted, nothing implemented — tasks 0/13. I've built the Design board from the spec: two new capabilities (refresh-observability, failure-classification), one modified (the lancelot field proof). There's no diff to lens yet, so it's Design only — coverage chips appear the moment a round returns code.",
    ],
  },
  {
    id: "pr1",
    speaker: "user",
    time: "2d ago",
    paragraphs: [
      "The \"attempt is visible before the network call\" requirement — its second scenario says daemon.log still shows the attempt if the process dies mid-refresh. Does the spec actually prove that, or is it only asserting emission order? If the log buffers, the attempt line might never flush.",
    ],
  },
  {
    id: "pr2",
    speaker: "orchestrator",
    time: "2d ago",
    preface: [
      {
        kind: "action",
        id: "pr-p4",
        label: "Read the spec delta",
        detail: "specs/github-token-refresh/spec.md",
        state: "done",
        icon: FileText,
      },
    ],
    paragraphs: [
      "As written it only asserts ordering: `attempt` is the first record emitted, before the network call. The scenario names process-death survival, but nothing in the spec obligates a flush — no crash-survival test, no fsync on the daemon.log sink. So the requirement is honest about intent but under-specified on durability. Before implementation you'd either add a scenario that pins the flush behaviour, or accept it and mark the second bullet as ordering-only. Worth a Request Changes on that scenario if you want the round to tighten it.",
    ],
  },
]

export const proposeScenario: Scenario = {
  id: "propose",
  projectId: "p1",
  session: {
    id: "s3",
    title: "Token refresh proposal",
    time: "2d",
    target: "your-branch",
  },
  cta: "Continue",
  transcript,
  // Design only — the view switcher shows Design + Diff automatically.
  boards: {
    design: designGen0Board,
  },
  handoff: {
    mode: "rounds",
    pr: {
      // Thin at propose stage, honest about it: the description ripens as rounds
      // return code. Converges on the real #438 as the change is implemented.
      title: "fix(adapters): observe GitHub token refresh",
      body: "Proposal drafted; nothing implemented yet (tasks 0/13). The pull request fills in as rounds land code.",
      ready: false,
    },
  },
}
