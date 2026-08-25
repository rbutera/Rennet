# Demo scenarios — the shared roster

The named workflows every prototype session exercises. Rai and agents refer to
scenarios by the short ids below; a sidebar session row maps 1:1 to a scenario,
and clicking it IS the scenario switch. Authority: rulings R1–R36 on the
[#458 canonical comment](https://github.com/rbutera/Rennet/issues/458#issuecomment-5387762167),
`docs/developing/concepts/handoff-and-exits.md`, `docs/developing/concepts/lens-pipeline.md`,
and root `CONTEXT.md` (Session targets, Review model).

## Roster

| id | flow | project · target | entry | lenses | hand-off lanes | CTA (R35) | starts in |
|---|---|---|---|---|---|---|---|
| `teammate` | W3 | rennet · **Teammate PR** (Priya, Needs you) | sidebar session (default active) or smart-list PR row | all five | Post Review (one lane) | **Write Review** | boards ready, mid-review, 0 asks |
| `rounds` | W1a | rennet · **Your branch** `fix/token-refresh-observability` | sidebar session or smart-list local row | all five (generation 1) | Changes → the Pull Request | **Continue · 2** | mid-review, 2 asks staged from real findings, round not yet dispatched |
| `returned` | W1b | same branch, after round 1 | drive `rounds` through its round, or `?scenario=returned` deep link | generation 2 (delta-marked) + generation 1 frozen | This Round (empty, gathering) + The Pull Request (ripe) | **Continue** | successor summary greeting on screen |
| `propose` | W2 | rennet · **Your branch**, spec only (2d-old session, same change pre-implementation) | sidebar session | **Design only** | Changes → the Pull Request | **Continue** | Design board ready, proposal untouched |

Diff is no segment in this table: it is the always-present raw-source toggle
beside Map (2026-08-25 ruling, issue #475; `components/diff-view.tsx`).

Explicitly out of scope: a Retrospective scenario (merged target, no exits —
R31). The smart list keeps one Merged row as chip-vocabulary texture; clicking
it stays the generic staged run.

## One demo world, two changes

Every scenario is grounded in a **real merged rennet change** — real paths,
real hunks, `/api/source` hydrating real files. The one staged element is
authorship framing, stated here once:

- **Change A — token refresh** (real [PR #438](https://github.com/rbutera/Rennet/pull/438),
  +423 −188, 9 files, openspec change `observe-github-token-refresh`). Owns
  `propose` → `rounds` → `returned`: one narrative arc, propose the spec (2d
  ago), review the implementation on the branch (now), run rounds, and the PR
  lane ripens toward the **real #438 title and body** — the demo's own-branch
  exit terminates in the pull request that actually shipped. The existing five
  lens fixtures (`lib/fixtures/*.ts`) are this change's generation 1.
- **Change B — the teammate PR.** A second real merged PR, pipeline-generated
  as its own board set (build step 5), framed as authored by **Priya** (the
  persona survives; the fictional auth-refactor content and the fictional
  "#434" number do not — real rennet has a real #434, a docs PR). Candidate:
  **#439** "feat(wsl): daemon-in-distro runtime" (+1724 −31, 19 files — the
  large-agent-change case the product exists for); lighter fallback **#433**
  "stream per-repo PR-fetch progress into the smart list" (+359 −36, 18
  files). Decide at generation time with `gh pr view`.

Chronology note, documented rather than hidden: change A's Flagged findings
were really raised against merged code (the concur-2/2 attempt-without-outcome
finding became issue #478). The demo re-stages them at the pre-PR moment,
which is where they would have been caught had Rennet existed then. Whether
`returned`'s generation-2 "addressed" blocks can cite real lines depends on
whether #478's fix has landed — check at build time; where it hasn't, changed
blocks carry literal `code` elements (the fixture-convenience kind), and only
carried-forward blocks hydrate.

---

## Scenario detail

### `teammate` (W3) — write the review

- **Target**: Teammate PR · Needs you. Session title derives from the ask,
  e.g. "Review Priya's #439". CTA **Write Review** (+ count once asks stage).
- **Transcript** (replaces the current one Rai called bogus): plausible
  session record grounded in the chosen PR's actual content —
  1. The conversational-add prior art stays at the top (the "Add ~/dev/orbital"
     exchange — it is the ruling exemplar for conversational acts narrating).
  2. User: "Open Priya's PR — the daemon-in-distro runtime." Orchestrator:
     prep tool lines (fetched PR, created worktree, read the diff with the
     real +/− counts), boards-ready line.
  3. One or two terse user questions about what the diff actually contains,
     answered with real citations (real paths, real line spans — `/api/source`
     must resolve every one). No invented code, no invented APIs (R17 spirit:
     staged demo transcripts are prior art, but they must read as records a
     real session would produce).
- **Boards**: change B's five lenses from a real pipeline run (drafting agents
  on `packages/lens-instructions` prompts, dual Flagged seats, unslop pass —
  the README documents the recipe).
- **Hand-off**: the existing `HandoffView` post-review lane, unchanged (R36
  two strata, verdict proposal, preview, Post Review).

### `rounds` (W1a) — your branch, mid-review, pre-round

- **Target**: Your branch `fix/token-refresh-observability`, no PR. CTA
  **Continue · 2**.
- **Boards**: the existing #438 fixtures as **generation 1**, with a small
  content pass: citations that name "the PR body" re-point at commits or the
  openspec change (no PR exists yet in this frame).
- **Pre-staged asks** (the honest ones — both are real findings from the
  dogfooded pipeline run):
  1. request-change · "log an outcome for every refresh attempt" (concur 2/2,
     the finding that became #478), with its codeAnchor;
  2. request-change · the post-send copy lie (Codex seat), with anchor.
- **Transcript**: "Review this branch before I open a PR." → branch-flavored
  prep lines → boards ready → one exchange about the retry-removal decision
  (real content) → two staging receipt lines ("Staged · request change · …" —
  receipt is the undo, R29).
- **Hand-off (new build — the R34 rounds lane)**: own-branch mode with two
  lanes. **Changes**: one card per staged ask (same steering verbs — Revise / Drop /
  Explain), primary action **Dispatch Round**; the pull request is one muted
  destination line until the asks are gone, at which point the surface IS the
  PR (R37).

### `returned` (W1b) — round 1 came back

- **Entry**: drive `rounds` live (Dispatch Round → the round watched live,
  ~10s simulated: created detached worktree · applying asks · agent activity
  lines · gate run · commits), or jump with `?scenario=returned`.
- **Greeting**: the successor summary fills the main surface on return (R34):
  addressed / partial / untouched / beyond-the-asks, each item tracing to its
  ask, one action back to the lenses and Hand off. Ask 1 addressed, ask 2
  partial or a beyond-the-asks test tightening — final content set by what the
  staged round can honestly claim (see the chronology note above).
- **Boards**: **generation 2**, delta-aware — changed sections marked
  natively, unchanged sections carried forward (they keep hydrating),
  generation 1 frozen and reachable as drill-down (a quiet "Generation 2 ·
  round 1" line, not chrome prose). Asks/threads/highlights re-anchor by quote
  match; a casualty may land in the Detached list to prove the state exists.
- **Drafting activity feed**: returns here (R32 amendment — the feed belongs
  to the rounds regeneration, not the Write Review lane): collapsed line over
  the surface, expanding to trigger queue + turn anatomy.
- **Exit**: The Pull Request lane is ripe — one **Open Pull Request** action;
  submitted state names the real #438. Rounds continue identically after (no
  self-review lane).

### `propose` (W2) — spec only, Design lens alone

- **Target**: Your branch, 2 days ago on the same arc — the session recorded
  when `openspec propose` had run and nothing was implemented. Sessions are
  records; this one opens its frozen generation (the propose-time boards),
  which is honestly how a 2d-old session on a since-moved branch behaves.
- **Board — Design generation 0**, derived from the existing `design.ts`
  fixture:
  - spec-header: same artifact set (proposal.md, design.md, specs · 3 deltas,
    tasks.md), **tasks 0/13** — the header states the stage in one place.
  - **No coverage chips.** Coverage is a relation to an implementation
    patchset; with no implementation there is no relation, and absent is
    honestly absent (the Design-lens rule for absent artifacts, applied to
    coverage). The all-amber alternative — nine identical "unimplemented ·
    0 hunks" chips — was considered and rejected: nine chips carrying one bit,
    and "unimplemented" falsely implies an implementation was attempted and
    missed. Chips appear the moment a round returns code.
  - what-changes spine **stays**: it derives from the proposal's declared
    deltas (ADDED/MODIFIED capabilities), not from hunks — pre-diff it means
    "what the spec commits this change to alter", which is exactly what a
    proposal review reads. The impact box stays too (its text is proposal
    content: "packages/adapters only… out of scope: Wave 6 field proof").
  - Requirement rows keep names, delta badges, verbatim SHALL/WHEN/THEN, and
    scenarios — all artifact content. Task-progress renders 0/N bars.
- **View switcher**: **Design only.** Absent lenses are absent segments, not
  disabled ones (a disabled segment is a fake affordance; law 10 — structure
  states it, chrome never explains it). Diff is not a segment: it sits beside
  Map as an always-present raw-source toggle (2026-08-25 ruling, issue #475).
  The `.openspec.yaml` scaffold
  stamp is Noise's lane (R22) but with no Noise board it lives in Design's
  `skippedHunks` — coverage as data, nothing rendered.
- **Run view**: branch prep lines, then a one-row lens table (Design only —
  the other lanes have nothing; an empty row per lens would be narration),
  then unslop + composed.
- **Transcript**: "I've drafted the token-refresh proposal — review the spec
  before anything gets built." → prep reads the spec artifacts → board ready →
  one exchange interrogating a requirement's scenario coverage.
- **Two round flavors from here** (both through the same This Round lane):
  - **Proposal iteration**: asks against spec artifacts ("tighten the
    classification requirement", a Request Changes selection on a proposal
    span) → dispatch → the round edits the artifacts → successor summary
    scoped to the spec → a new Design-only generation.
  - **Implementation hand-off**: an ask that says build it ("implement task
    groups 1–2") → dispatch → the returned generation has code, so all five
    lenses mint and the session has transitioned into the `rounds` shape. In
    the prototype this is a scripted transition that lands on change A's
    generation 1 — the same boards `rounds` starts from, which is the point:
    W2 flows into W1 on the same real change.
- The Pull Request lane is visible from the start (R31: always visible,
  ripening) — thin at this stage, honest about it by being thin.

---

## Sidebar roster (1:1 with scenarios)

Sessions removed: "Trace session-scoping regression", "Rewrite lens board
schema", "Migrate search index", both billing-service sessions, "Profile
inference latency". Projects removed: docs-site, ranking-model.

```
THIS MACHINE
  rennet
    ● Review Priya's #439            Teammate PR · Needs you · now   → teammate
      Token refresh before the PR    Your branch · 1h                → rounds (→ returned)
      Token refresh proposal         Your branch · 2d                → propose
  orbital                            (no sessions — conversational-add prior art)
DEV-BOX
  billing-service                    (no sessions — remote-host proof + smart-list furniture)
GPU-01                               (paired, not connected — no projects; settings demo)
```

Multi-host grouping **earns its place with less**: dev-box proves the Source
grouping and feeds the New chat furniture (`smartList.p2`); gpu-01 survives
only because the settings view's not-connected → Connect demo reads from the
same `hosts` data — and an empty header under a disconnected host is *more*
honest than the ranking-model project it currently claims to list. If the
sidebar renders an empty remote host badly, that is a small render fix, not a
reason to re-add fake projects.

Session titles stay harness-derivable (from the session's first ask); if
change B's PR changes, the title follows it.

**Smart list (p1)** trimmed to cohere with the world: Priya's PR (Needs you →
starts `teammate`), local `fix/token-refresh-observability` (→ starts
`rounds`), one real Merged row (#437) as chip texture (generic run on click),
and the pinned "Current checkout · main" default. The fictional #441/#439
rows and the "#438 merged" row go — #438 cannot be both merged in the list
and pre-PR in the rounds arc. `p2` stays as-is (furniture; generic run).

---

## Fixture architecture

**`lib/scenarios/`** — a registry, not an engine:

```ts
// lib/scenarios/index.ts
export type ScenarioId = "teammate" | "rounds" | "returned" | "propose"

export interface Scenario {
  id: ScenarioId
  projectId: string
  session: SessionItem                      // the sidebar row — 1:1
  target: { kind: TargetKind; state?: TargetState; label: string }
  cta: "Write Review" | "Continue"
  transcript: TurnData[]
  boards: Partial<Record<LensId, LensBoard>> // absent lens = absent segment
  handoff:
    | { mode: "post-review" }
    | { mode: "rounds"; pr: { title: string; body: string; ready: boolean } }
  seedAsks?: AskSeed[]                      // pre-staged into the comment store
  round?: {                                 // `returned` only
    summary: SuccessorSummary               // addressed / partial / untouched / beyond
    gen1: Partial<Record<LensId, LensBoard>> // frozen drill-down
  }
}
```

One file per scenario (`teammate.ts`, `rounds.ts`, `returned.ts`,
`propose.ts`) holding its transcript and presets; boards stay in
`lib/fixtures/` because they are shared real artifacts, not per-scenario
props. `sidebar-data.ts` derives its session rows from the registry so the
1:1 mapping cannot drift.

**Switching**: `AppShell` holds `activeScenario`; a sidebar session click sets
it (replacing today's "any row returns to the demo chat"); `?scenario=` is
read once on load (prior art: story-2 `?variant=` routes). `ChatColumn` stops
importing `conversation-data` directly and takes the scenario's transcript;
`MainSurface` takes the scenario's boards, CTA, and hand-off mode instead of
its hard-coded `VIEWS` + `"Write Review"`. Props first; introduce a context
only if the drilling gets noisy.

**Real vs staged** (say it once, keep it true):

| Real | Staged |
|---|---|
| The five #438 lens fixtures and change B's future set (actual pipeline runs) | Transcripts (plausible session records, grounded in the real change) |
| `/api/source` hydration — every citation resolves against the checkout | Run-view timing, the simulated round, orchestrator replies in quote threads |
| The pre-staged asks (real findings; one is issue #478) | The successor summary and generation-2 delta marks |
| The ripened PR description (the real #438 body) | Priya's authorship of change B; the propose-time frame of change A |
| Target vocabulary, CTA rules, lane shapes (R29–R36) | Scenario switching itself (a registry lookup, not a session engine) |

**New chat / Add project**: unaffected structurally. New chat rows whose
target matches a scenario start that scenario's session; other rows keep the
generic staged run (prep → run view → change A's boards). Add project /
indexing / context map stay scenario-independent — a freshly added project
lands on the honest empty New chat state and never claims a scenario.

---

## Build order (one commit-able chunk each)

1. **Registry + sidebar cleanup.** `lib/scenarios/` with `teammate` wrapping
   today's content; `AppShell` scenario switching; sidebar/smart-list roster
   trim; `ChatColumn`/`MainSurface` take scenario props. Sidebar rows for the
   other scenarios do NOT appear yet — a row with no scenario behind it is a
   lie; each lands with its step.
2. **`rounds` (W1a).** The R34 own-branch hand-off build: This Round + The
   Pull Request lanes, Dispatch Round, work-order living draft; pre-PR
   citation touch-ups on the #438 fixtures; seeded asks; transcript; CTA
   Continue; sidebar row.
3. **`returned` (W1b).** The round watched live (~10s), successor-summary
   greeting, generation 2 with carry-forward + frozen generation 1 drill-down,
   drafting activity feed (its R32-sanctioned home), Open Pull Request →
   submitted state naming the real #438; `?scenario=returned`.
4. **`propose` (W2).** Design generation-0 fixture derived from `design.ts`
   (tasks 0/13, no coverage chips), absent-lens switcher behavior, one-row run
   view, transcript, sidebar row; proposal-iteration round flavor + the
   scripted implement-hand-off transition into `rounds`.
5. **`teammate` rebuild.** Choose change B (`gh pr view 439` vs `433`), run
   the real lens pipeline (drafters + dual Flagged seats + unslop, per the
   README recipe), write the grounded transcript, retire the auth-refactor
   fiction and the "#434" number. Mostly an agent content job — independent
   of steps 2–4 and parallelizable any time after step 1.
6. **Coherence pass.** Smart-list → scenario mapping, dead fixture data
   removed from `conversation-data.ts`/`smart-list-data.ts`, README pointer to
   this file, screenshots to `wireframes/`, ruling-log append on #458.

Per the working agreement: features-only, component tree restated before the
structural steps (1–3), minimal styling, every new label harness-derivable,
`npx tsc --noEmit` + live Playwright verification per step.
