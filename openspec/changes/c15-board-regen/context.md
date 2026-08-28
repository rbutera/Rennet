# Board Regeneration Workstream — Scoping (read-only, main @ b5d5331a)

New workstream: per-round board REGENERATION ("raise the collation-bridge ceiling", B11-flagged).
When a work-order round completes, mint a NEW generation of lens boards (delta-aware: unchanged
sections carry forward, touched re-draft), freeze the prior generation, and drive the live
regeneration UI. Nine C9-tagged claims (INVENTORY §7 "Progressive reveal" + "rounds ledger" +
"after the round"; §3 C5 lines 346/347) must become verifiable-present.

The load-bearing fact: **`runLensPipeline` and `RoundsRuntime.runRound` have ZERO prod callers.**
`grep` confirms only `rounds.ts` calls `runLensPipeline`, and `runRound` is called nowhere in
prod (only `dispatchRound` is wired, at create-server.ts:1629 — it runs the worker turn and
re-composes the PR, but NEVER regenerates boards). The prod board surface today is the
DETERMINISTIC `buildReviewCanvases` (core/src/pipeline.ts:68) which returns `canvases: {}` — the
model drafters have never run in production. This workstream is therefore the first prod exercise
of the entire model-drafting pipeline, not merely a round trigger. That is the central risk.

---

## 1. The collation bridge — size: **L** (the pivot; contains the real risk)

`runRound` (rounds.ts:320) is fully wired internally but needs a `RoundInput` (rounds.ts:118)
carrying `deltaPacket`, `hunks: LintHunk[]`, `lintContextFor: (lens) => LintContext`,
`previousGeneration`, and optionally `previous: Map<LintTarget, DraftBoard>`. No prod path builds
these. What the bridge must construct:

- **DeltaPacket + successorAccount** — MOSTLY EXISTS. `buildDeltaPacket(patchset, knowledge,
  dossier, successorAccount)` (core/src/delta/delta-packet.ts:96) and `buildSuccessorAccount`
  (already called at core/src/index.ts:661 on patchset activation) both exist and are tested.
  Work = source `knowledge`/`dossier` at the round trigger and thread the account through. Small.
- **`LintHunk[]`** — NEW converter. `decompose(patchset).hunks` are decomposition `Hunk`s and
  `buildHunkIndex` (hunk-index.ts:93) emits `new: {start,lines}` — NOT the flat `LintHunk`
  {id,path,newStart,newLines,oldStart,oldLines} the pipeline's `assertCoverage`/lint want
  (lint.ts:51). A ~30-line mapper over the patchset/decomposition. Straightforward, testable.
- **`lintContextFor(lens): LintContext`** — NEW builder, nothing like it in prod. Must build
  head-side + base-side `files` line-count inventories from the patchset, `patchsetId`, the
  per-lens hunk slice, `scaffoldGlobs`. Shape is small (lint.ts LintContext) but it is net-new.
- **The `runRound` trigger** — NEW wiring. After `runWorkers` returns (the handoff turn at
  create-server.ts:1633), call `roundsRuntime.runRound(...)` with the collation context + the
  session's `previousGeneration` + prior boards. Today dispatchRound stops at the worker + PR
  re-compose; this replaces/extends that tail with the regeneration.

Existing vs needed: pure round mechanics (serialize, mint, freeze, idempotency guard, durable
reconstruct) ALL exist and are E2E-tested. Missing is exactly the 3 input builders + the trigger.
**Risk lives here** because it is the first prod run of `runLensPipeline` — live claude/codex
ports, on-disk prompts, six model drafters that must emit boards passing lint + coverage. That is
an integration unknown, not a design unknown.

## 2. Delta-aware regeneration — size: **S–M** (pipeline logic exists; supply its inputs)

The pipeline ALREADY branches on `isRound = deltaPacket.successorAccount !== undefined`
(lens-pipeline.ts:717) and consumes `input.previous` for R58 delta stamps; the R58
`delta: "new"|"reworked"` stamp is set "by the composition step at regeneration"
(protocol/board/schema.ts:149). The UI side is done: `board/section.tsx:22` opens touched
sections expanded, `board/viewed-delta.ts` clears on interaction, INVENTORY §3 C5 delta marks all
tagged built. Needed: SUPPLY `previous` (prior generation's `DraftBoard`s as
`Map<LintTarget,DraftBoard>`) and the successorAccount to the round call.
Caveat: `draft()` (rounds.ts:264) mints 6 fresh boards and re-drafts every lens each round —
"carrying-forward" is a UI STATE LABEL, not a compute skip. If Rai wants true carry-forward
(untouched lens NOT re-drafted, saving model spend), that is extra pipeline work (M→L) and should
be an explicit decision, not assumed. Recommend: ship the label-honest version, question the skip.

## 3. Generation mint + freeze — size: **S** (pure fns exist; add durability)

`mintGeneration`/`freezeGeneration`/`withLensBoards` (rounds.ts:82-105) exist; `runRound` already
returns `boardGeneration` + `frozenPrevious`. `BoardMetaStore` persists per-board meta. Gaps:
(a) the RoundRecord ledger is an in-memory `Map` (rounds.ts:218) — not durable; C09 cluster (a)
is adding a durable RoundRecord write with NO mint. This workstream fills the MINT side: persist
the `Generation` (frozen prior + live successor) so gen-1 survives as a drill-down across restart,
and stamp `mintedPatchsetGeneration`/`boardGeneration` onto the durable record. Small, patterned
on BoardMetaStore.

## 4. Live regeneration UI wiring — size: **M** (components built; no live feed)

BUILT by C09 clusters 5/6, honest-absent, fixture-driven:
- `rounds/round-machine.ts` — pure `advance(state,event)` over `RoundEvent`s; `canRevealNewBoards`
  gates View-the-New-Boards at `composed` only (never a disabled button — claim satisfied by
  construction).
- `rounds/round-greeting.tsx` — `RegenerationProgress` per-lane block + reveal button; report
  readable above, non-locking `<section>`.
- `store/run.ts` — per-lane regen status; `rounds/rounds-ledger.tsx`.

Fed ONLY by `test/fixtures/rounds/timeline.ts` (`FIXTURE_ROUND_TIMELINE`). NO live feed exists —
nothing converts the server's real round progress (`onBoardArrival`, pipeline phases, mint/compose)
into `RoundEvent`s over the wire and into `advance()`. That live channel is the bulk of cluster 4.
Plus these honest-absent GAPS (grep found NONE in non-test app-ui):
- "Cleaning up drafts · post-process pass" + "Composed generation 2" synthetic steps — NOT rendered.
- Kicker MISMATCH: greeting renders "Re-drafting the boards"; claim wants
  "Regenerating the Boards" → "Regenerated the Boards". Label swap on phase.
- Retrospective collapsed line "Regenerated the boards · N reworks · generation M" — NOT in ledger.
- Regenerated board's gen-1 drill-down + generation/round intro line — fixture-only
  (`lib/fixtures/flagged-gen2.ts` in the spike); needs render off real frozen-prior data (cluster 3).

---

## Proposed cluster breakdown (4)

| # | Cluster | Size | Verifiable-present claims it lands |
|---|---------|------|-----------------------------------|
| 1 | **Collation bridge** — LintHunk mapper, `lintContextFor`, deltaPacket+successorAccount sourcing, `runRound` trigger after worker. FIRST prod `runLensPipeline`. | L | none directly, but PREREQ for all — makes real regeneration data exist |
| 2 | **Generation mint/freeze durability** — persist Generation, freeze prior, durable RoundRecord mint fields, expose gen-1 drill-down data | S | gen-1 drill-down + intro line (data); retrospective "generation M / N reworks" (data); "new generation, prior frozen" |
| 3 | **Live round-progress channel** — pipeline phases + onBoardArrival → `RoundEvent` over WS → `advance()` in prod (replace fixture) | M | report readable while drafters regen live; per-lens regen block; kicker Regenerating→Regenerated; View-New-Boards real gating; surface never locks |
| 4 | **UI completions** — post-process + "Composed generation 2" steps, kicker text swap, retrospective line render, gen-1 drill-down + intro render | S–M | "post-process pass" + "Composed generation 2"; retrospective line (render); gen-1 drill-down + intro (render) |

Clusters 3+4 are coupled (4's steps ride 3's stream) and could merge under one UI-owning team;
kept split to isolate the risky wire (3) from bounded render polish (4). Cluster 1 gates 2/3/4 —
real data must flow before the UI can show anything but fixtures.

**All 9 claims land: C1 report-readable→c3+c1 · C2 per-lens block→c3 · C3 post-process/Composed→c4
· C4 kicker→c4 · C5 View-New-Boards→c3 · C6 non-locking→c3 · C7 retrospective→c4+c2 · C8 gen-1
drill-down→c2+c4 · C9(§3 intro line)→c2+c4.**

## Overall size: **L** (upper-L / low-XL if the pipeline's first prod run misbehaves)

Most pieces exist and are tested (mint/freeze/serialize/idempotency, deltaPacket, successorAccount,
the whole UI machine + greeting). The work is a converter + a context builder + persistence + a
live event channel + bounded UI render — WIRING, not green-field. What pushes toward XL is only
risk realization in cluster 1.

## Key risks

1. **First prod `runLensPipeline` (HIGH, contained).** The model drafters have never run in
   production; buildReviewCanvases is the current floor. Six drafters must emit boards passing
   lint + coverage over live ports + prompts. Mitigation: cluster 1's FIRST task is a thin
   smoke-run of `runRound` against a real small patchset before any UI is built on top. This is
   an integration unknown, not a design one.
2. **Carry-forward semantics (MEDIUM, decision).** `draft()` re-drafts every lens each round;
   "carrying-forward" is currently a label, not a model-spend skip. Confirm with Rai whether the
   label-honest version suffices or true skip-untouched-lens is required (adds M–L to cluster 2/1).
3. **Prior-generation sourcing (LOW-MED).** `previous` boards map + `previousGeneration` must be
   reconstructed per session across restart; leans on cluster 2's durability. If a session has no
   stored prior generation the round must degrade to a first-generation draft, not crash.
4. **Live-channel ordering (LOW).** The machine is forward-only + tolerant of dup/reorder, so the
   wire is low-risk; the real cost is defining the `RoundEvent` wire schema and the server emitter.
