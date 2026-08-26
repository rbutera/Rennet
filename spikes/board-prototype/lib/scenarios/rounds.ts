/**
 * `rounds` (W1a) — your branch, mid-review, pre-round. The token-refresh
 * change (real PR #438) reviewed on its branch before any PR exists: the
 * existing five #438 lens fixtures are generation 1, two real findings are
 * pre-staged as asks, and the hand-off opens the R34 own-branch lanes
 * (This Round + The Pull Request). See SCENARIOS.md.
 */

import { FileText, FolderSearch, GitBranch, GitCommitHorizontal } from "lucide-react"
import type { Scenario } from "./index"
import type { TurnData } from "@/lib/conversation-data"
import { designBoard } from "@/lib/fixtures/design"
import { sequenceBoard } from "@/lib/fixtures/sequence"
import { decisionsBoard } from "@/lib/fixtures/decisions"
import { flaggedBoard } from "@/lib/fixtures/flagged"
import { noiseBoard } from "@/lib/fixtures/noise"

const GITHUB_AUTH = "packages/adapters/src/github-auth.ts"

/** The real #438 body — the PR lane ripens toward exactly this description. */
export const PR_438_TITLE = "fix(adapters): observe GitHub token refresh, drop the unsafe retry"

export const PR_438_BODY = `## What

Make the GitHub token **refresh** observable and correct. The token lifetime was never the bug — the bug was that renewal is invisible: the refresh exchange emitted zero logs, so a field failure could only be *inferred*, and it had never been confirmed to succeed even once.

## Why

On lancelot (0.3.14) a \`project.detail\` PR fetch reported the token expired and forced a device-flow re-auth. The refresh path was fully wired and the store sound — but silent. This adds the missing observability and, along the way, review caught and removed a genuinely unsafe retry.

## Changes

- **Observability**: \`refreshAndPersist\` emits a secret-free \`RefreshLogRecord\` — \`attempt\` before the exchange (survives a mid-refresh crash), then \`persisted\` / \`declined\` / \`network\`. A decline carries GitHub's **verbatim \`error\` code** (\`bad_refresh_token\`, …) so the real cause is finally knowable. \`create-server\` writes each as one \`[github-auth]\` line to \`daemon.log\`. The record type has **no field that can hold a secret**, so a credential can't be logged even by mistake; \`tokenKind\` returns only an allowlisted GitHub prefix (or the fixed \`"token"\`), never a slice.
- **Correct retry ownership** (review finding): the shared GitHub transport (\`withConnectResilience\`) already retries a **connect-phase** blip once, replay-safely, and deliberately never replays a post-send failure. An earlier draft added a second retry in \`refreshAndPersist\` — redundant *and* unsafe, since \`isGitHubNetworkError\` also matches post-send errors that could have already rotated the pair (retrying then burns a rotated token). **Removed it**; the refresh layer now only *observes* a network failure and propagates. Classification unchanged: decline → \`token-invalid\`, network → \`network\` with the credential byte-untouched.

## Not in this PR

Disabling token expiry (dodges the fix). The **live lancelot field proof** (Wave 6) — observing a refresh succeed-and-rotate, or capturing the real decline code — is deferred to a manual run since it needs the real account.

## Tests

9 new/tightened tests in \`github-auth.test.ts\`: declined → exact \`[attempt, declined]\` + verbatim code + no write + secret-free; network → exact \`[attempt, network]\`, \`refresh()\` called **exactly once**, credential unchanged; success → \`persisted\` with allowlisted \`tokenKind\`; adversarial \`tokenKind("customerSecret_body") === "token"\` (not a slice); sentinel secret-safety across success/network/declined records.

## Process

Implemented with the wave skill, dual review-gated (Opus + Codex) per wave. Codex caught the unsafe/redundant retry and the \`tokenKind\` leak surface (Wave 1) and a declined-path coverage hole (Wave 2) — all fixed and re-verified. Full \`pnpm check\` green (14 projects); adapters 719/14, server 496.

OpenSpec change: \`github-token-refresh-reliability\`.
`

const transcript: TurnData[] = [
  {
    id: "r1",
    speaker: "user",
    time: "09:40",
    paragraphs: [
      "Review this branch before I open a PR — fix/token-refresh-observability. It adds refresh logging and drops a retry; tell me what's risky before it becomes a PR, not a summary I can read off the diff.",
    ],
  },
  {
    id: "r2",
    speaker: "orchestrator",
    time: "09:40",
    preface: [
      { kind: "action", id: "r2a", label: "Read the working tree", detail: "fix/token-refresh-observability", state: "done", icon: GitBranch },
      { kind: "action", id: "r2b", label: "Mapped commits against main", doneDetail: "4 commits", state: "done", icon: GitCommitHorizontal },
      { kind: "action", id: "r2c", label: "Read the diff", doneDetail: "+423 −2 · 9 files", state: "done", icon: FileText },
      { kind: "action", id: "r2d", label: "Gathered related context", doneDetail: "the github-auth + transport layer", state: "done", icon: FolderSearch },
    ],
    paragraphs: [
      "Boards are ready. This is the token-refresh observability change: a secret-free RefreshLogRecord on the refresh path, and the removal of a second retry the shared transport already owns. Two things stand out on the read — both are on the Flagged board, each raised by both review seats.",
    ],
  },
  {
    id: "r3",
    speaker: "user",
    time: "09:43",
    paragraphs: ["Walk me through the retry removal — why was the one you dropped unsafe?"],
  },
  {
    id: "r4",
    speaker: "orchestrator",
    time: "09:43",
    streaming: true,
    preface: [
      {
        kind: "thought",
        id: "r4t",
        state: "done",
        seconds: 5,
        text: [
          "The question is whether the removed retry was redundant with the transport's own connect-phase retry, and whether replaying the refresh POST is ever safe.",
        ],
      },
      { kind: "action", id: "r4a", label: "Read 2 files", detail: "github-auth.ts, github-fetch.ts", state: "done", icon: FileText },
    ],
    paragraphs: [
      "The shared transport (`withConnectResilience`) already retries a connect-phase blip once, replay-safely, and deliberately never replays a post-send failure. An earlier draft added a second retry inside `refreshAndPersist` — redundant with that, and unsafe: `isGitHubNetworkError` also matches post-send errors, and GitHub may have already rotated the pair on the send, so a retry there burns a token that just became valid. Dropping it is the right call; the refresh layer now only observes a network failure and propagates. That leaves the reporting of that same post-send case as the open question — which is the second finding.",
    ],
  },
  {
    id: "r5",
    speaker: "user",
    time: "09:45",
    paragraphs: ["Both findings need to change before this is a PR. Stage them for a round."],
  },
  {
    id: "r6",
    speaker: "orchestrator",
    time: "09:45",
    paragraphs: [
      "Staged · request change · log an outcome for every refresh attempt — the exchange-error and persistence-failure exits leave `attempt` with no terminal record. (github-auth.ts:262)",
      "Staged · request change · the post-send network copy asserts the credential is untouched; after a reset on a successful send the token is already rotated. (github-auth.ts:295)",
      "Both are in This Round. Continue when you want to dispatch it.",
    ],
  },
]

export const roundsScenario: Scenario = {
  id: "rounds",
  projectId: "p1",
  session: {
    id: "s2",
    title: "Token refresh before the PR",
    unreadUpdates: true,
    time: "1h",
    target: "your-branch",
  },
  cta: "Continue",
  transcript,
  boards: {
    design: designBoard,
    sequence: sequenceBoard,
    decisions: decisionsBoard,
    flagged: flaggedBoard,
    noise: noiseBoard,
  },
  handoff: {
    mode: "rounds",
    pr: { title: PR_438_TITLE, body: PR_438_BODY, ready: false },
  },
  seedAsks: [
    {
      text: "Log an outcome for every refresh attempt — the exchange-error and persistence-failure exits leave `attempt` with no terminal record.",
      intent: "request-change",
      source: "finding · refresh can log attempt with no outcome",
      codeAnchor: { path: GITHUB_AUTH, line: 262 },
    },
    {
      text: "The post-send network copy says the credential is untouched, but a reset after a successful send means the token is already rotated. Report an unknown outcome instead.",
      intent: "request-change",
      source: "finding · post-send reset reported as untouched",
      codeAnchor: { path: GITHUB_AUTH, line: 295 },
    },
  ],
}
