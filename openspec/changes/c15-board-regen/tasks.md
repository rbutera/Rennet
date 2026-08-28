# Tasks — c15-board-regen (C15: per-round board regeneration goes live)

Read `openspec/BUILD-LOOP.md` and `proposal.md` (its Reconciliations section is part of the spec) first. One cluster per session; the repo compiles and the gate is green after every cluster; one commit per checked task. Every task is a real, checkable unit with a positive control that can fail.

**Cluster 1 GATES clusters 2–4.** Real regeneration data must exist before the UI or the persistence can show anything but fixtures. Do NOT check any task in clusters 2, 3, or 4 until its cluster-1 dependency has landed (each such task names its gate). Checking a cluster 2–4 task against fixture data is a hollow pass — forbidden by BUILD-LOOP "no placeholder or stub implementations."

Sources of record: `docs/developing/concepts/handoff-and-exits.md` ("Rounds: the own-branch loop" items 4–7, "What a round measures itself against"); the C09 change (`openspec/changes/c09-rounds/` — the UI machine + greeting + ledger this feeds, and finding F3's parked frozen-predecessor gap); INVENTORY §7 + §3 C5 (the nine claims). Reused landed surfaces: `runRound` + `mintGeneration`/`freezeGeneration` (`server/src/runtime/rounds.ts`), `buildDeltaPacket` (`core/src/delta/delta-packet.ts`), `buildSuccessorAccount` (`core/src/index.ts:661`), the pipeline's `isRound` branch (`server/.../lens-pipeline.ts:717`), `buildHunkIndex` (`hunk-index.ts:93`), `LintContext`/`assertCoverage` (`lint.ts`), the C09 machine + seam (`packages/app-ui/src/rounds/`), `BoardMetaStore` (the persistence pattern). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

---

## 1. The collation bridge — first prod run of the drafting pipeline (GATES 2–4)

- [x] 1.1 **SMOKE-RUN FIRST (Rai directive; the single largest integration unknown).** Before ANY other C15 work, prove the drafting pipeline executes in production: a thin smoke-run of `roundsRuntime.runRound(...)` against a real small patchset, exercising `runLensPipeline` end to end over live claude/codex ports and on-disk prompts. Confirm the six model drafters emit boards that pass lint + coverage — they have NEVER run in production (the live surface is deterministic `buildReviewCanvases`, which returns `canvases: {}`). **Positive control:** the run produces a real minted `Generation` with non-empty boards passing `assertCoverage`; a drafter that emits a coverage-failing board surfaces as a real error, not a swallowed empty. **A surprise here is STOP-AND-REPORT to the orchestrator, NOT push-through** — do not stub around a misbehaving first prod run. This task's outcome gates every task below; commit the smoke-run harness + its evidence.
- [x] 1.2 `LintHunk[]` converter: a mapper from `decompose(patchset).hunks` / `buildHunkIndex` output (`new: {start,lines}`) to the flat `LintHunk` `{id,path,newStart,newLines,oldStart,oldLines}` the pipeline's `assertCoverage`/lint consume (`lint.ts:51`). **Positive control:** a unit test over a known patchset asserts the emitted `LintHunk`s' path/newStart/newLines/oldStart/oldLines against hand-computed values; a hunk whose line range is dropped fails coverage.
- [x] 1.3 `lintContextFor(lens): LintContext` builder: head-side + base-side `files` line-count inventories from the patchset, `patchsetId`, the per-lens hunk slice, `scaffoldGlobs`. **Positive control:** a unit test asserts the built `LintContext` for a fixture patchset has the right file inventory + per-lens hunk slice; a lens with hunks outside its slice is excluded.
- [x] 1.4 DeltaPacket + successorAccount sourcing at the round trigger: source `knowledge`/`dossier` at the trigger point and thread the already-built `SuccessorAccount` (from `buildSuccessorAccount`, `core/src/index.ts:661`) through `buildDeltaPacket`. **Positive control:** the built `DeltaPacket` has `successorAccount !== undefined` (so the pipeline's `isRound` branch fires); a trigger with no successor account produces a first-generation (non-round) packet, not a crash.
- [x] 1.5 The `runRound` trigger: after `runWorkers` returns (the handoff turn, `create-server.ts:1633`), call `roundsRuntime.runRound(...)` with the collation context (1.2–1.4) + the session's `previousGeneration` + prior boards (`Map<LintTarget, DraftBoard>`). Extends `dispatchRound`'s tail (today it stops at worker + PR re-compose). **Degrade honestly:** a session with no stored prior generation runs a first-generation draft, it does not crash. **Positive control:** an integration test drives a real dispatch through the trigger and asserts a new generation is minted with the report drafting before the lenses; a session with no prior generation mints gen-1 without error. Cluster gate green. Commit.

## 2. Generation mint/freeze durability (GATED on cluster 1 — do not check until 1.5 lands)

Fills the MINT side of the C09 (a) RoundRecord-write gap and un-parks C09 finding F3 (the frozen-predecessor field).

- [x] 2.1 Persist the `Generation` (frozen prior + live successor) so gen-1 survives across a restart as a drill-down. Pattern on `BoardMetaStore`. **Positive control:** write a generation, restart (fresh store instance over the same on-disk state), read it back — the frozen prior's board generation is intact; an unpersisted generation is honestly absent, not fabricated.
- [x] 2.2 Stamp `mintedPatchsetGeneration` / `boardGeneration` **and the frozen-predecessor generation id** onto a durable RoundRecord (the record ledger is an in-memory `Map` today, `rounds.ts:218`). **Positive control:** a completed round's durable RoundRecord carries a frozen-predecessor id distinct from the minted id (the F3 shape the fixture faked); a first-generation round carries no predecessor (honest absence). This un-parks the ledger's `GenerationSwitcher` from C09's single-generation fallback.
- [x] 2.3 Expose the gen-1 drill-down data — the frozen-prior board generation reachable by id — so the ledger's switcher has a real earlier generation to open. **Positive control:** a two-round session exposes both generations by id; the switcher-facing read returns the frozen gen-1 boards, not the live gen-2. Cluster gate green. Commit.

## 3. The live round-progress channel (GATED on cluster 1 — do not check until 1.5 lands)

Replaces `FIXTURE_ROUND_TIMELINE` in the app tree with a real feed. The C09 machine (`advance`) is forward-only + dup/reorder-tolerant; the cost is the wire schema + emitter.

- [x] 3.1 Define the `RoundEvent` wire schema (the folded-progress payload the machine's `advance` consumes) and the server emitter that converts real round progress — pipeline phases + `onBoardArrival` + mint/compose — into `RoundEvent`s over the WS channel. **Positive control:** an integration test drives a real round and asserts the emitted event sequence walks `preparing → working → gating → committing → reporting → composing → composed`; a crashed worker still emits a terminal event (not silence).
- [x] 3.2 Fold the live channel into the `useRoundState` read via `useCommandStream`, swapping the `rounds/rounds-data.ts` seam body (mirror C09 cluster-8; callers unchanged, fixtures kept for tests). **Positive control:** over the live source the run route's rows advance on real events (no fixture clock); the default source stays honest-absent. This lands C1 (report readable while drafters regenerate live), C2 (per-lens block), C5 (**View the New Boards** real gating at `composed`), C6 (surface never locks).
  - **Honest scope note (C1 half-landed).** The live channel carries the report's ARRIVAL (`{type:"report", reportBoardId}`), so the greeting phase is real and the surface never locks. But the report BOARD itself still resolves absent: **no board-fetch command exists in the protocol at all** — `commands/index.ts` registers none, and `board/board-data.ts` records the same gap for the lens boards (B4/B10's declared job). The live source cannot invent a board it has no way to read, so `reportBoard` stays honest-absent rather than fabricating a greeting. C1's *readability* half needs that command; C2/C5/C6 land here in full.
- [x] 3.3 **Carry-forward lane label — HARD CONSTRAINT (Rai ruled; not a note).** The live emitter's lens-level "carrying forward" lane label MUST derive from the SAME `stampDeltas` signal as the section markers (a lens with zero `new`/`reworked` sections = carried), never a cheaper heuristic. Section-grain honesty already holds by construction (`compose.ts:167–175` gates a carried marker to `subtreeSignature` equality). **Positive control (must be able to fail):** a lens whose sections actually changed does NOT render "carrying forward" — a test drives a round where lens X's sections change and lens Y's do not, and asserts X's lane reads regenerating/reworked while only Y's reads "carrying forward". A lane that lied ("carrying forward" over changed sections) is a UI lie, a Rule-Zero bug. Cluster gate green. Commit.

## 4. UI completions (GATED on cluster 1 — do not check until 1.5 lands; render gaps ride cluster 3's stream)

- [x] 4.1 **Kicker text (Rai ruled — verbatim, C14 verifies the exact strings).** In `round-greeting.tsx` replace "Re-drafting the boards" (line ~51) with **"Regenerating the Boards"** while running and **"Regenerated the Boards"** when finished — a label swap on phase. **Positive control:** a DOM test asserts the exact string "Regenerating the Boards" during a regeneration phase and "Regenerated the Boards" at `composed`; the old "Re-drafting the boards" string is absent. Lands C4.
- [x] 4.2 Render the synthetic pipeline steps "Cleaning up drafts · post-process pass" and "Composed generation 2" from the real phases in the progress block. **Positive control:** a DOM test over a live round asserts both step labels appear at their phases; they are absent before their phase (not pre-rendered). Lands C3.
- [x] 4.3 Render the retrospective collapsed ledger line "Regenerated the boards · N reworks · generation M" from the settled report + durable record (cluster 2 data). **Positive control:** a DOM test asserts the line with the real rework count and generation id from a completed round; a round with zero reworks reads "0 reworks", not a fabricated count. Lands C7 (with cluster 2).
- [x] 4.4 Render the regenerated board's gen-1 drill-down + the generation/round intro line off real frozen-prior data (cluster 2's exposed generation, `2.3`), replacing the spike's `flagged-gen2.ts` fixture. **Positive control:** a DOM test drives a two-generation session and asserts the gen-1 drill-down renders the real frozen boards + the intro line; a single-generation session shows no drill-down (honest). Lands C8 + C9 (with cluster 2). Cluster gate green. Commit.

## 5. Packet verification — E2E + docs, full gate

- [x] 5.1 The C15 E2E over a real (or live-shaped) round, driving the real UI, evidence shown not asserted: **real dispatch** → `runRound` trigger → **first prod `runLensPipeline`** mints a generation → **live progress** streams into the run route (real events, no fixture clock) → **report greets** while the drafters regenerate → **View the New Boards** at real composition → **durable RoundRecord** in the ledger with a reachable frozen gen-1 → **kicker verbatim** "Regenerating"→"Regenerated". All nine C9 claims verifiable-present against real data.
- [x] 5.2 Positive controls that can fail, each flipped-to-red-then-reverted (record the red): (a) 1.1 smoke-run coverage control; (b) 3.3 carry-forward-lane lie control (changed-lens must not read "carrying forward"); (c) 4.1 kicker verbatim strings; (d) 2.2 durable frozen-predecessor id distinct from minted. Confirm each genuinely fails when its invariant is broken.

  **Recorded reds (each mutated from a committed baseline, run, then `git checkout --`):**

  | control | mutation | red |
  |---|---|---|
  | (a) 1.1 smoke-run coverage | `compose.ts` `assertCoverage` filters `() => false` (swallow every uncovered hunk) | `core` `compose.test.ts` **4 failed / 10 passed**. The smoke's control is the identical call (`assertCoverage(realBoards, [unteachable])`, `rounds-smoke.test.ts:313`) and returns `[]` under the same mutation. The smoke itself stays `RENNET_SMOKE=1`-only — reddening it would buy nothing over reddening the function it asserts on, at the price of six live drafter turns. |
  | (b) 3.3 carry-forward lane lie | `rounds.ts` `arrived()` hardcodes `detail: "carrying forward"` | `server` `round-progress.test.ts` **2 failed / 5 passed** — `expected 'carrying forward' to be 'reworked'` on the changed-lens lane. |
  | (c) 4.1 kicker verbatim | `round-greeting.tsx` kicker reverts to `"Re-drafting the boards"` | `app-ui` **3 failed / 13 passed** — both greeting kicker tests and the C15 packet E2E. |
  | (d) 2.2 durable frozen predecessor | `rounds.ts` drops the `frozenPredecessor` stamp | `server` `rounds.test.ts` **1 failed / 7 passed** — `expected undefined to be 'gen:ps-0'`, the exact C09 F3 shape the fixture used to fake. |
- [x] 5.3 Docs (definition of done): update `docs/developing/concepts/handoff-and-exits.md` items 4–7 from planned-Rennet framing to live where C15 makes it so, and record the carry-forward semantics (label-honest; section-grain honest by construction via `subtreeSignature`; true skip-untouched-lens deferred). Grep `docs/` (excl. `docs/dist`) for pages the change makes wrong and update or record the grep as a no-op.

  **Grep result** (`carry forward|carrying forward|carry-forward|regenerat|Re-drafting|re-draft` and
  `roundProgress|roundEvents|RoundEvent`, `docs/` less `docs/dist`): twelve files hit, four wrong,
  four updated.

  - `handoff-and-exits.md` — the "board regeneration … is not yet wired to a production caller"
    caveat is now false (it is the dispatch's tail); item 5 said carried lenses do not re-draft;
    added **Carry-forward is a verdict, not a skip** recording all three properties (label-honest
    off the same stamps; section grain honest by construction via the subtree signature; the
    compute skip DEFERRED) plus the report-body read gap (arrival live, no fetch-by-id command).
  - `using/guides/getting-started.md` — "Boards nothing touched carry forward; boards the round
    changed re-draft" read as a compute skip; now the lane verdict it actually is.
  - `reference/protocol-compatibility.md` — the session-frame table omitted `roundProgress` (C15's,
    and `boardEvent`/`askProjection` while there); added, with the snapshot/forward-only-fold
    contract and the `session.roundEvents` catch-up read beside it.
  - No-op (checked, already correct): `delta-rereview-and-lineage.md` and `architecture-contracts.md`
    (element/section grain, accurate), `using/concepts/common-questions.md` (section grain),
    `using/index.md`, `lens-pipeline.md`, `harness-adapters.md`, `dependency-standard.md`,
    `contracts-and-rulings.md`, `plans/board-rebuild-plan.md`.
- [ ] 5.4 Full gate `sh -c 'pnpm check'` green (format, architecture, licenses, lint, typecheck, test, build). Confirm the protocol change is scoped to the `RoundEvent` wire schema + durable RoundRecord fields (not assumed). Commit. Output the completion sigil `<promise>C15-COMPLETE</promise>` and flip C15's entry in `BUILD-STATUS.json`.
