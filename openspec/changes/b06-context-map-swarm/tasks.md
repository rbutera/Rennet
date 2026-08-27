# B06 tasks — context-map-swarm

Serial clusters; fresh implementer session per cluster; one commit per checked task; no placeholders. Gate per cluster: `pnpm nx affected -t lint,typecheck,test` green with EXIT captured on its own line. Ledger rule: an amendment discovered mid-cluster is recorded in proposal.md in the same commit.

## Cluster 1 — council rows

- [x] 1.1 `core/model-council.ts`: `JOB_CATALOGUE` gains `partition-worker` (light, batched) and `map-verify` (heavy, per-call); all three assignment tables gain rows — both: luna/low + sonnet-5/medium; claude-only: haiku/low + sonnet-5/medium; codex-only: luna/low + terra/medium (mark `[extrapolated]` where #460 is silent, house style). Ids must match protocol `COUNCIL_JOB_IDS` (reconciliation 1 — no protocol edit).
- [x] 1.2 Tests: `resolveAssignment` resolves both ids under all three scenarios + degraded; cross-harness flag correct for partition-worker under `both`.
- [x] 1.3 Gate green.

## Cluster 2 — partitions (invisible plumbing)

- [x] 2.1 (amendment 9: `knowledge.ts` re-homed as `knowledge/read.ts` — folder/file collision) `packages/core/src/knowledge/partition.ts`: `buildPartitions(snapshot, cap ≈ 120)` — one slice per workspace scope (from the structural snapshot's `scopes`); a scope over the cap subtree-splits (directory prefix walk) until under it; files outside every scope (or no scopes at all) fall back to top-level-directory slices. Every in-scope file in EXACTLY one slice, by construction. Pure; no I/O. `core/knowledge/index.ts` is the folder's import surface.
- [x] 2.2 Tests: total coverage (union = inventory, pairwise disjoint) on real-shaped fixtures incl. oversized-scope split and the no-scopes fallback; determinism (same snapshot → same slices, stable order).
- [x] 2.3 Gate green.

## Cluster 3 — worker + verify/synthesis passes

- [x] 3.1 Extract the mint-time honesty helpers from `knowledge-generation.ts` (anchor→blobOid resolution, anchor-or-drop, hypothesis stamping, statement id mint) into `core/knowledge/mint.ts`, reused verbatim — no second implementation. Flat pass keeps compiling by importing them (deletion comes in cluster 5).
- [x] 3.2 `core/knowledge/swarm.ts`: `runPartitionWorker(slice, snapshot, runTurn)` — per-slice prompt + the worker output schema (existing statement fields + optional `hint`), minted through `mint.ts`; `hint` survives only in the worker result envelope. `runMapVerify(workerResults, snapshot, runTurn)` — re-reads cited spans (anchor-bounded), flips each hypothesis to `confirmed`/`rejected`, mints cross-cutting statements (same honesty contract), dedups by statement id; output is a `KnowledgeSet` (B03 shape, consumed not re-modeled). Both pure over injected `runTurn`; NO budget parameter (reconciliation 4).
- [x] 3.3 Tests: worker mint honesty (unresolvable path dropped, unanchored statement dropped, hypothesis label, hint discarded from the final set); verify flips per span evidence; cross-cutting statement minted + anchored; dedupe.
- [x] 3.4 Gate green.

## Cluster 4 — incremental delta (partition-routed)

- [x] 4.1 `core/knowledge/incremental.ts`: `routeDelta(partitions, changedPaths)` → the owning partitions to re-run; `planReverify(knowledgeSet, changedPaths)` → statements whose cited evidence changed (cross-cutting statements re-verify when ANY cited path changed); everything else carried verbatim with the shipped carry semantics (reuse the carry logic from the flat delta pass — extract, don't rewrite).
- [x] 4.2 Tests: one changed file re-runs exactly its owning partition; untouched statements carry byte-identical; evidence-touched statements queued for re-verify; cross-cutting sensitivity.
- [x] 4.3 Gate green.

## Cluster 5 — council-routed execution + scheduling + retirement

- [x] 5.1 Adapters: `knowledge-swarm.ts` — resolve `partition-worker`/`map-verify` via `resolveAssignment` (availability from the installed-harness discovery adapters already use), build the concrete `runTurn` on the RESOLVED harness (Claude port as today; Codex via the existing codex utility port), fan out workers with a bounded concurrency, feed `runMapVerify`, write the store. No `InvocationBudget` on this path (reconciliation 4). Record the actual availability/wiring source in the ledger. (Landed: availability = the ports the composition root resolved — claude-code iff `claudePort`, codex iff `codexExecutor`; `snapshotContextFromLoaded`/`changedPathsBetween` re-homed here from the retiring flat orchestration.)
- [x] 5.2 `packages/server/src/runtime/knowledge-swarm.ts`: the scheduler — initial run on project add, partition-routed delta on baseline advance (the events `create-server.ts:1338` / `cli.ts:586` fire today), progress lines per partition (queued/running/statement counts) + a verify-stage line over the existing progress channel. Re-point both callers. Record the wiring point in the ledger (reconciliation 3). (Landed: wiring points recorded in amendments 10–11 — rehydration `runKnowledgePass` + cli `enrichMap`, both through `createKnowledgeSwarmRuntime`; progress = the additive `knowledge` snapshot-stage value on the rehydration push.)
- [x] 5.3 Retirement (migrate-callers-then-delete, reconciliation 6): delete `runKnowledgeEnrichment`, `runKnowledgeDeltaPass`, `DEFAULT_KNOWLEDGE_MAX_FILES`, `enrichKnowledgeForRepo`'s flat orchestration and any now-dead prompt/schema code; `mint.ts` + carry helpers survive as the swarm's substrate. Grep proof: zero non-test references to the deleted names. (Landed: zero references in ANY .ts under packages/apps/scripts, tests included — amendment 12 records the third migrated caller and the re-homed survivors.)
- [ ] 5.4 Contract tests for the real path (reconciliation 5): assignment routing per scenario reaches the right harness port with the right model/effort; turn construction carries the worker output schema; no live model call anywhere in the gate.
- [ ] 5.5 Gate green (positive proof: `pnpm nx run-many -t typecheck -p rennet-core rennet-server rennet-adapters` — no consumer lost an export).

## Cluster 6 — docs

- [ ] 6.1 `docs/using/guides/context-map.md`: generation is a partitioned swarm (invisible plumbing — scopes + statements are what the user sees), model verdicts with optional human override (never a gate), incremental on baseline advance, uncapped by design.
- [ ] 6.2 `docs/developing/concepts/code-intelligence.md` + `model-council.md`: the two new job rows, the council-routed knowledge path (the off-council asymmetry is gone), the 400-file cap's death. Sweep `docs/` for stale flat-pass claims.
- [ ] 6.3 Gate green (docs test inside).

## Cluster 7 — verification

- [ ] 7.1 `pnpm check` → EXIT=0 on its own line, tail shown.
- [ ] 7.2 Packet E2E (stub `runTurn`, reconciliation 5) against THIS repo's real snapshot: partitions cover every in-scope file exactly once; every emitted statement's anchors resolve against the snapshot inventory; then a small synthetic baseline advance (one touched file) re-processes ONLY the owning partition — carry visible (untouched statements byte-identical in the output set).
- [ ] 7.3 Positive controls, fail-then-revert with evidence: (a) drop a file from every slice → coverage assert fails; (b) break anchor resolution in the stub's output → the mint drops it and the anchors-resolve assert fails; (c) widen routeDelta to all partitions → the only-touched-partition assert fails. Revert, re-run green, tree clean.
- [ ] 7.4 BUILD-STATUS.json: `b06` → `{"status":"done","passes":true}` (only that line). Commit, push, local == origin.
- [ ] 7.5 Output the sigil: `<promise>B06-COMPLETE</promise>`
