# C15 — Per-round board regeneration: the rounds loop goes live (the collation bridge, generation mint/freeze durability, the live progress channel, and the UI completions)

## Why

C09 built the whole rounds *experience* — the run route, the report-as-greeting, the progressive-reveal control, the ledger, the delta marks — and shipped it **honest-absent**, fed only by `test/fixtures/rounds/timeline.ts`. The canonical behavior it renders (`docs/developing/concepts/handoff-and-exits.md`, "Rounds: the own-branch loop", items 4–7, and "What a round measures itself against") is not yet **live**: no production path converts a real round into the boards the reviewer reads. C15 makes it live. It builds the collation bridge that lets `RoundsRuntime.runRound` run in production, persists the generation it mints so the frozen prior survives as a drill-down, streams the real round progress into the UI machine that today only walks a fixture clock, and finishes the four UI affordances the fixture never exercised. This closes the honest-present half C14 (the conformance sweep) needs: **nine C9-tagged claims** that are wired-but-fixture-fed today become verifiable-present against real data.

The load-bearing fact — and the central risk — is that **`runLensPipeline` and `RoundsRuntime.runRound` have ZERO production callers.** `runRound` (`server/src/runtime/rounds.ts:320`) is fully wired internally and E2E-tested, but nothing in production calls it; only `dispatchRound` is wired (`create-server.ts:1629`), and it runs the worker turn and re-composes the PR draft but **never regenerates boards**. The live board surface today is the DETERMINISTIC `buildReviewCanvases` (`core/src/pipeline.ts:68`), which returns `canvases: {}`. **The six model drafters have never executed in production.** So C15 is not merely a round trigger — it is the first production exercise of the entire model-drafting pipeline, over live claude/codex ports, on-disk prompts, six drafters that must emit boards passing lint + coverage. That is an integration unknown, not a design unknown, and it is why cluster 1's very first task is a thin smoke-run of `runRound` against a real small patchset (§Cluster 1). **A surprise there is STOP-AND-REPORT, not push-through.**

What already exists and is tested (this change is WIRING, not green-field): the pure round mechanics — `mintGeneration` / `freezeGeneration` / `withLensBoards` (`rounds.ts:82–105`), `runRound`'s serialize / mint / freeze / idempotency guard / durable reconstruct — all exist and are E2E-tested; `buildDeltaPacket` (`core/src/delta/delta-packet.ts:96`) and `buildSuccessorAccount` (already called at `core/src/index.ts:661` on patchset activation) exist and are tested; the pipeline already branches on `isRound = deltaPacket.successorAccount !== undefined` (`lens-pipeline.ts:717`) and consumes `input.previous` for the R58 delta stamps; and the entire C09 UI machine + greeting + ledger + delta marks are built and DOM-tested. The gaps are exactly four seams: three input builders + a trigger (cluster 1), generation persistence (cluster 2), a live event channel (cluster 3), and four bounded UI renders (cluster 4).

## What Changes

### Cluster 1 — The collation bridge (size L; the pivot; GATES clusters 2–4)

`runRound` needs a `RoundInput` (`rounds.ts:118`) carrying `deltaPacket`, `hunks: LintHunk[]`, `lintContextFor: (lens) => LintContext`, `previousGeneration`, and optionally `previous: Map<LintTarget, DraftBoard>`. No production path builds these. This cluster constructs them and wires the trigger.

- **A smoke-run FIRST (Rai directive).** Before anything in C15 rides on the drafting pipeline, prove it executes in production: a thin smoke-run of `runRound` against a real small patchset, exercising `runLensPipeline` end to end over live ports and on-disk prompts, confirming the six drafters emit boards that pass lint + coverage. This is the single largest integration unknown in the build (see §Why). It is task 1.1, and its result gates every other task in C15. A failure here is **STOP-AND-REPORT** — do not push through a misbehaving first prod run by stubbing around it.
- **`LintHunk[]` converter** — NEW. `decompose(patchset).hunks` are decomposition `Hunk`s and `buildHunkIndex` (`hunk-index.ts:93`) emits `new: {start,lines}` — NOT the flat `LintHunk` `{id,path,newStart,newLines,oldStart,oldLines}` that the pipeline's `assertCoverage` / lint consume (`lint.ts:51`). A ~30-line mapper over the patchset/decomposition, testable in isolation.
- **`lintContextFor(lens): LintContext` builder** — NEW, nothing like it in production. Builds head-side + base-side `files` line-count inventories from the patchset, `patchsetId`, the per-lens hunk slice, `scaffoldGlobs`. Small shape (`lint.ts` `LintContext`), net-new.
- **DeltaPacket + successorAccount sourcing** — MOSTLY EXISTS. Source `knowledge` / `dossier` at the round trigger and thread the already-built `SuccessorAccount` through `buildDeltaPacket`. Small.
- **The `runRound` trigger** — NEW wiring. After `runWorkers` returns (the handoff turn at `create-server.ts:1633`), call `roundsRuntime.runRound(...)` with the collation context + the session's `previousGeneration` + prior boards. Today `dispatchRound` stops at the worker + PR re-compose; this extends that tail with the regeneration. Degrade honestly: a session with no stored prior generation runs a first-generation draft, it does not crash.

### Cluster 2 — Generation mint/freeze durability (size S; pure fns exist, add durability)

`runRound` already returns `boardGeneration` + `frozenPrevious`, but the RoundRecord ledger is an in-memory `Map` (`rounds.ts:218`) and the frozen predecessor is dropped from the record. **This is the MINT side of the C09 (a) RoundRecord-write gap** — C09 review finding F3 parked exactly this as a "B9 schema gap": the frozen predecessor the ledger's generation switcher would drill back to is never persisted. C15 fills it.

- Persist the `Generation` (the frozen prior + the live successor) so gen-1 survives as a drill-down across a restart, patterned on `BoardMetaStore`.
- Stamp `mintedPatchsetGeneration` / `boardGeneration` and the frozen-predecessor id onto a **durable** RoundRecord (this fills what the C09 (a) RoundRecord-write leaves as honest-no-mint).
- Expose the gen-1 drill-down data (the frozen-prior board generation) so the ledger's `GenerationSwitcher` has a real earlier id to hand — no longer the single-generation honest fallback F3 shipped.

### Cluster 3 — The live round-progress channel (size M; the risky wire)

The C09 machine (`rounds/round-machine.ts` `advance(state,event)`) is forward-only and tolerant of dup/reorder, but is fed ONLY by `FIXTURE_ROUND_TIMELINE`. **No live feed exists.** This cluster builds it: convert the server's real round progress — pipeline phases + `onBoardArrival` + mint/compose — into `RoundEvent`s over the WS channel and fold them into `advance()` in production, replacing the fixture timeline in the app tree (the fixtures stay for tests).

- Define the `RoundEvent` wire schema and the server emitter (the machine already tolerates ordering, so the wire is low-risk; the cost is the schema + emitter).
- Fold the live channel into the `useRoundState` read via `useCommandStream`, mirroring C09's cluster-8 seam swap — the seam's callers do not change, only its body.
- **Carry-forward is LABEL-HONEST, and the lane label is a hard design constraint here (not a note).** Section-grain honesty holds by construction: the board displays the fresh re-draft, but a "carried" (no-dot) section marker is granted only when `subtreeSignature(previous) === subtreeSignature(current)` (`compose.ts:167–175`), so a carried section's displayed bytes are gated to equal the prior generation's. True skip-untouched-lens (not re-drafting an untouched lens to save model spend) is a **deferred cost optimization** — there is no cost cap, and adding it to an upper-L live-integration workstream is bad sequencing — so it is explicitly NOT in C15. BUT the lens-level "carrying forward" LANE in the regeneration block is fixture-fed today with no real-compute emitter. **The live emitter MUST derive that lane label from the SAME `stampDeltas` signal** (a lens with zero `new`/`reworked` sections = carried), never a cheaper heuristic. If a live emitter ever put "carrying forward" on a lane while that lens's sections actually changed, that is a UI lie — a bug under Rule Zero ("a lie in the UI is a bug"). The positive control for the task: a lens whose sections changed must NOT render "carrying forward".

### Cluster 4 — UI completions (size S–M; components built, render the missing pieces)

Bounded render polish riding cluster 3's stream. Four affordances the fixture never exercised (grep found NONE in non-test app-ui):

- The synthetic pipeline steps "Cleaning up drafts · post-process pass" and "Composed generation 2" — rendered from real phases.
- **Kicker text (Rai ruled): standardize on the claim's verbatim wording.** Replace the current "Re-drafting the boards" (`round-greeting.tsx:51`) with **"Regenerating the Boards"** while running and **"Regenerated the Boards"** when finished — a label swap on phase. C14 verifies the exact strings; they are verbatim, not paraphrase.
- The retrospective collapsed ledger line "Regenerated the boards · N reworks · generation M" — rendered from the real settled report (data from cluster 2).
- The regenerated board's gen-1 drill-down + the generation/round intro line — rendered off real frozen-prior data (cluster 2), replacing the spike's `lib/fixtures/flagged-gen2.ts`.

## The nine C9 claims → cluster that makes each verifiable

| # | Claim (INVENTORY §7 / §3 C5) | Cluster(s) |
|---|------------------------------|-----------|
| C1 | Report readable while the drafters regenerate live | c3 + c1 |
| C2 | Per-lens regeneration block | c3 |
| C3 | "Cleaning up drafts · post-process pass" + "Composed generation 2" steps | c4 |
| C4 | Kicker "Regenerating the Boards" → "Regenerated the Boards" | c4 |
| C5 | **View the New Boards** real gating (appears at composition, never disabled) | c3 |
| C6 | The surface never locks (non-locking during regeneration) | c3 |
| C7 | Retrospective line "Regenerated the boards · N reworks · generation M" | c4 + c2 |
| C8 | Regenerated board's gen-1 drill-down | c2 + c4 |
| C9 | §3 C5 generation/round intro line | c2 + c4 |

Cluster 1 lands none of the nine directly, but is the PREREQ for all: real regeneration data must exist before the UI can show anything but fixtures. This is why cluster 1 gates 2–4, and why tasks in 2–4 are explicitly not to be checked until their cluster-1 dependency lands.

## Out of scope

- **True skip-untouched-lens carry-forward** (not re-drafting an untouched lens to save model spend) — a deferred cost optimization, not in C15 (see cluster 3). C15 ships label-honest.
- **The round engine internals** (B8/B9/B11) — the worker, the report drafter seat, `mintGeneration` / `freezeGeneration` / the append-then-freeze model. All exist and are tested; C15 supplies their production inputs and persists their output, it does not rebuild them.
- **The C09 UI surface** — the run route, report-as-greeting, ledger, delta marks. Built and DOM-tested; C15 feeds them real data and finishes the four render gaps, it does not re-litigate the surface.
- **No protocol change beyond the `RoundEvent` wire schema and the durable RoundRecord fields** cluster 2/3 add — the round shapes (`RoundRecord`, `round_outcome`, `SectionDelta`, `Generation`) already exist.

## Reconciliations (part of the spec)

1. **`runLensPipeline` / `runRound` have zero production callers — cluster 1 is the first prod run.** The current live board surface is deterministic `buildReviewCanvases`. This is the central risk; cluster 1's first task is the smoke-run that de-risks it, and a failure is STOP-AND-REPORT.
2. **Mint mechanics exist; only durability is missing.** `mintGeneration` / `freezeGeneration` / `runRound`'s return are landed and tested. Cluster 2 adds persistence and the durable RoundRecord fields — it fills the MINT side of the C09 (a) RoundRecord-write gap and un-parks C09 review finding F3 (the frozen-predecessor field). It does not touch the pure mint functions.
3. **The pipeline already branches on `isRound` and consumes `input.previous`.** Cluster 1 supplies `deltaPacket.successorAccount` and the `previous` board map; the R58 delta stamp is already set by the composition step (`protocol/board/schema.ts:149`). C15 supplies inputs, it does not add pipeline delta logic.
4. **The machine tolerates dup/reorder — the live wire is low-risk.** `advance` is forward-only and idempotent per event. Cluster 3's cost is the `RoundEvent` schema + the server emitter, not the machine.
5. **Carry-forward is honest by construction at section grain; the lane label is the one place a live emitter could lie.** `compose.ts:167–175` gates a carried marker to `subtreeSignature` equality, so displayed bytes match the prior generation. The lens-level lane label must derive from the same `stampDeltas` signal — a hard cluster-3 constraint with a positive control, not a note.

## Impact

- **New:** the collation-bridge builders in `server`/`core` (the `LintHunk` mapper, the `lintContextFor` builder, the round trigger); a generation-persistence store (patterned on `BoardMetaStore`); the `RoundEvent` wire schema + server emitter; the live seam-body swap in `packages/app-ui/src/rounds/rounds-data.ts`.
- **Touched:** `create-server.ts` (the `runRound` trigger after `runWorkers`); `server/src/runtime/rounds.ts` (durable RoundRecord fields + generation persistence); `packages/app-ui/src/rounds/round-greeting.tsx` (kicker text, post-process/"Composed generation 2" steps, lane label) and `rounds/rounds-ledger.tsx` (retrospective line, gen-1 drill-down render); the `rounds-data.ts` seam body.
- **Docs:** `docs/developing/concepts/handoff-and-exits.md` — the rounds loop moves from planned-Rennet framing to live where C15 makes it so (items 4–7), with the carry-forward semantics (label-honest, section-grain by construction) recorded. Update every page the change makes wrong in the same change (definition of done).
- **Rule Zero:** C15 is real capability — the product's rounds loop going live. No consent/ceremony in the design. Never fabricate a generation or a board; a session with no stored prior generation degrades to a first-generation draft, it does not invent one.
