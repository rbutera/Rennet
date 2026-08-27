# B08 tasks — lens-pipeline

Serial clusters, each a separately-reviewable **sub-wave** (B08 is XL — the orchestrator lands it in these clusters). Fresh implementer session per cluster; **one commit per checked task**; no placeholders or stubs. Gate per cluster: `pnpm nx affected -t lint,typecheck,test` green with EXIT captured on its own line (`$?` on its own line, not a masked pipe status). Ledger rule: an amendment discovered mid-cluster is recorded in `proposal.md` in the same commit. All B03-frozen schemas (`DraftBoardSchema`, `ViolationSchema`, `BlemishSchema`, `LensBoardSchema`, `SkippedHunkSchema`) are consumed, never re-modeled (reconciliation 2).

## Cluster 1 — council rows (job ids: J1, J2)

- [x] 1.1 `core/model-council.ts`: `JOB_CATALOGUE` gains `lens-draft`, `lens-draft-flagged`, `lens-draft-noise` (drafting seats), `board-post-process` (the editor pass), and `round-report` (the per-round seat); all three assignment tables (both / claude-only / codex-only) gain rows. `lens-draft-flagged` is the DUAL seat with cross-harness `agreement` routing (Claude + Codex on the same instructions under `both`); mark `[extrapolated]` where #493/#464 are silent on effort (house style). Ids must match `protocol` `COUNCIL_JOB_IDS` — no protocol edit (reconciliation 3).
- [x] 1.2 Tests: `resolveAssignment` resolves all five ids under all three scenarios + degraded; `lens-draft-flagged` reports the dual/cross-harness flag correctly under `both`; the Flagged dual-seat merge still routes through `finding-reconcile` (J2).
- [x] 1.3 Cluster gate green. Commit.

## Cluster 2 — lint rules + schema constraints (V1; #493 conflicts F1–F4)

- [x] 2.1 `packages/core/src/board/lint.ts`: `lint(draft: DraftBoard, ctx) => Violation[]` — the 19 rules + schema constraints from #493 (reconciliation 4: derive the exact set from #493; the rule families are in the planned docs page). Cover at minimum: kind-allowlist-per-lens (thread/message kinds never from a drafter); **no code bytes** (R17 — code on a board is a `code_ref`; enforce at parse time via the derived draft schema AND as a lint rule) with the **R20 backtick + patchset-identifier exemption** (F2); every citation resolves against the patchset; `skippedHunks` present per board; structured-fields-where-required (a finding's fix is a field, not buried prose); the **process-vocabulary screen** flagging prose that names lenses/boards/agents/seats/drafts — applied to `review-draft-voice.md`'s write-through register too (F3). The schema is B03's derivation — never hand-edit it, and no spike drift propagates into it (F4). Pure; no I/O. `core/board/index.ts` is the folder's import surface.
- [ ] 2.2 Tests: each rule fires on a violating draft and passes a clean one; R17 rejects code bytes but R20 exempts backticked identifiers + patchset ids; the process-vocab screen catches machinery prose; a Violation carries `ruleId` + `elementRef` + `message`; parse-time code-byte rejection returns ZodError-shaped issues.
- [ ] 2.3 Cluster gate green. Commit.

## Cluster 3 — validation loop + retry ladder (V2, V3, V4, V5)

- [ ] 3.1 `packages/core/src/board/validate.ts`: the retry channel — a lint failure returns the draft to its seat as **ZodError-shaped JSON pointers** on one channel; the seat returns a **patch**; passing elements **freeze** (a frozen element is never re-linted or re-drafted). A **4-rung escalation** ends in an **honest-omission exit**: drop the offending element and move its hunks to `skippedHunks` with a reason. **Retry cap 10**; on exhaustion the draft ships with labeled `blemishes[]` (`BlemishSchema` — `Violation` + `attempts`), **visible, never blocking**. Enforce the **three gates in order**: lint (pre-post-process) → immutability check → composition every-hunk check. Pure over an injected re-draft `runTurn` seam.
- [ ] 3.2 Tests: a violation returns pointers and the patched element re-lints while frozen elements are untouched; the ladder escalates rung-by-rung and lands an unfixable element as an honest omission (its hunks in `skippedHunks`); cap 10 exhaustion produces a blemish with `attempts`, not a throw and not a block; gate ordering asserted (immutability runs after lint, composition after immutability).
- [ ] 3.3 Cluster gate green. Commit.

## Cluster 4 — composition mechanics (C1, C3)

- [ ] 4.1 `packages/core/src/board/compose.ts`: the mechanical composition — the **coverage assertion** (across all lens boards every patchset hunk is taught by some lens or in some lens's `skippedHunks`; a hunk in neither fails the assert), **verbatim carry on stable element ids** (a carried element is byte-identical across generations), and **delta stamps** (`new`/`reworked` on sections; absent = carried). The lens boards ARE the reading surface — compose produces no sixth board (C3). Pure; reuse the carry/stamp shapes from `session/` (`SectionDeltaSchema`) — do not re-model.
- [ ] 4.2 Tests: full coverage passes; a hunk covered by no lens fails the assert; a stable-id element carries byte-identical; a new/reworked section carries its delta stamp; no composed board is emitted.
- [ ] 4.3 Cluster gate green. Commit.

## Cluster 5 — drafting pipeline runtime (D1, D2, D3, C2, council-routed execution)

- [ ] 5.1 `packages/server/src/runtime/lens-pipeline.ts`: the scheduler. Seed one drafter harness session per lens **in the PR worktree** with the **inlined DeltaPacket (B5) + the lens prompt (`@rennet/prompts` `LENS_PROMPT_FILES`) + the host board schema** (D1). Validate each structured return via `DraftBoardSchema` (`parseDraft`); the host writes board ops on the drafter's behalf through **`whiteboard-client`** — the sole op writer; drafters never call whiteboard tools (D2). Run each draft through the cluster-3 validation loop, then the **`board-post-process`** editor pass (`POST_PROCESS_FILE`), then persist. Council-route every seat via `resolveAssignment` on the RESOLVED harness (Claude port / Codex utility port, B06 precedent for availability). Record the wiring point in the ledger.
- [ ] 5.2 Flagged dual seat: run `lens-draft-flagged` as two independent seats (Claude + Codex) under `both`, merge via `finding-reconcile` with per-finding cross-model concurrence, route by `agreement` (J1/J2). Degrade to a single seat when only one harness is available (honest single-seat concurrence).
- [ ] 5.3 Round-report FIRST on rounds (D3, R58): when a round returns, run the `round-report` drafter (`ROUND_REPORT_FILE`) BEFORE the lens drafters — it gates the regeneration and is the drafters' input. Emit **per-board arrival events** over B04's existing board-event broadcast as each board freezes (these power the B09 R58 reveal; B08 emits, B09 consumes). Round-report funnels through the same post-process pass; it is not a sixth lens.
- [ ] 5.4 Composition authoring (C2): the orchestrator applies the mechanical `compose` (cluster 4) plus the **write-through authored** connective prose on the versioned composition prompt (`REVIEW_DRAFT_VOICE_FILE` — reconciliation 5), in the reviewer's first-person register; the same post-process steps apply. Curation feedback is threaded into the next generation's packet.
- [ ] 5.5 Tests: contract tests for the real path — seat routing per scenario reaches the right harness port with the right model/effort; the turn carries DeltaPacket + lens prompt + host schema; a valid structured return is written via `whiteboard-client` and NO other module writes board ops (reuse B04's writer-invariant scan); round-report runs before lens drafters on a round; per-board arrival events fire on freeze. No live model call in the gate (inject `runTurn`).
- [ ] 5.6 Cluster gate green (positive proof: `pnpm nx run-many -t typecheck -p rennet-core rennet-server rennet-adapters rennet-protocol`). Commit.

## Cluster 6 — concurrency measurement (M1, engine asset risk 3)

- [ ] 6.1 Measure the **warm-session concurrency cost** against real harness sessions before trusting the cap-10 fan-out (packet-required). Record the measurement — the numbers and the verdict (keep 10, or the revised cap) — in `proposal.md` §Concurrency measurement. If the measurement moves the cap, update the cluster-5 runtime concurrency in the same commit.
- [ ] 6.2 Cluster gate green. Commit.

## Cluster 7 — docs (definition of done)

- [ ] 7.1 Make `docs/developing/concepts/lens-pipeline.md` **live**: reconcile the planned page against what B08 actually built (drafting flow, the three-gate validation loop, the 19-rule lint, honest-omission + blemishes, mechanical-vs-authored composition, the round-report-first ordering) — correct any planned-vs-shipped drift, drop future-tense hedging for what now exists.
- [ ] 7.2 Sweep `docs/` (excluding `docs/dist`) for stale claims about drafting/lint/composition a reader would now find wrong (e.g. the B04 note at `lens-pipeline.md:22` on lens naming, and any `model-council.md` gap on the five new job rows). Fix stragglers.
- [ ] 7.3 Cluster gate green (docs check inside). Commit.

## Cluster 8 — verification (packet)

- [ ] 8.1 `sh -c 'pnpm check'` green — EXIT=0 on its own line, tail shown.
- [ ] 8.2 Packet E2E against a real Rennet PR (inject `runTurn` where a live model would run — the pipeline plumbing is pure over the seam): five frozen lens boards in the event log; every patchset hunk either covered by a lens or in some `skippedHunks` set; a deliberately-invalid drafter return exercises the retry ladder and lands as a labeled blemish, not a block. Show the passing run output.
- [ ] 8.3 Positive controls, fail-then-revert with evidence: (a) leave one hunk covered by no lens → the composition every-hunk assert fails; (b) feed a draft carrying code bytes → the R17 parse/lint gate rejects it; (c) break a citation → the citation-resolves rule fires. Revert, re-run green, tree clean.
- [ ] 8.4 `BUILD-STATUS.json`: `b08` → `{"status":"done","passes":true}` (only that line). Check all boxes; commit; push; verify local == origin.
- [ ] 8.5 Output the sigil: `<promise>B08-COMPLETE</promise>`
