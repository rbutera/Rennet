# Tasks: Repo Map lifecycle

Dependency-ordered. Three tracks (Storage, Delta-pass+Overlay, Net-novel) are largely independent and **parallelize across worktrees** after the shared foundation (T0). Within a track, order is sequential. `[P]` marks a task that can run concurrently with the other tracks' `[P]` tasks in its own worktree.

## T0 — Shared foundation (do first, blocks the `[P]` tracks)

- [ ] T0.1 Confirm the five residual §8 decisions with Rai (leading-dash in the escaped path, knowledge storage location, knowledge-pass budget + re-rollup threshold, overlay+knowledge retention, promoted-map scope). All are small; none blocks starting T0.2/T0.3.
- [ ] T0.2 `escapePath(absPath)` in `@rennet/core` (pure): resolve → replace `{/ \ :}` with `-` → collapse `-` runs. Cross-platform (POSIX + Windows drive/UNC). Table-test the exact examples in design §1.2 including the Windows case. **Blocks Storage track.**
- [ ] T0.3 Add `projectSnapshotId` to `@rennet/types` `Patchset` (Contracts §3.1) and thread it through diff capture so a Patchset is stamped with the snapshot it was computed against. Update `NoveltyLedgerReader.classify` to pin on `patchset.projectSnapshotId` (removing the `repository.baseOid` stand-in). Core + types only. **Blocks Net-novel track.**

## Track A — Storage, travel & promotion (#141) `[P]` after T0.2

- [ ] A.1 `[P]` Re-home the store: `baseDir = ~/.rennet/projects/`, per-project key = `escapePath(gitTopLevel)`, layout `config.json` + `map/` + `overlays/` (design §1.1). Replace the `sha256Hex(git-common-dir)` `repoDir()`. Update `snapshotStoreFor` composition. Test: two checkouts at different paths get distinct entries; the same checkout is stable.
- [ ] A.2 `[P]` `projectContext.visibility: local | git-visible` switch: preview the filesystem diff, change only Rennet-owned exclusion state, never `git add`/`rm --cached`/`commit`; pre-tracked files reported, never restaged. Test the "git status unchanged" and "index untouched" invariants.
- [ ] A.3 Opt-in **promotion** writer (adapters), default off: write `map/` into `<repo>/.rennet/map/` on the default branch; record promotion in `config.json`. Test: default-off leaves the repo untouched; on-promote writes a valid, re-discoverable map.
- [ ] A.4 Committed-map **discovery + validation** reader (adapters): on open, detect `<repo>/.rennet/map/`, re-verify integrity + fingerprint via `verifySnapshotIntegrity`, seed the local store on success, ignore on failure. Test: a corrupt/mismatched committed map is ignored, never served.
- [ ] A.5 **Precedence** resolver: local `~/.rennet/projects/<esc>/map` first, committed `<repo>/.rennet/map` fallback, build if neither. Test the ordering, especially on a non-default branch.
- [ ] A.6 `relocate <old> <new>` + **aliases** (adopted from codeindexer): rename the project dir without reindexing; aliases resolve to the same project; record in `config.json`. Test: relocate preserves the map; an alias resolves.

## Track B — Proactive delta pass + overlay (#143 MVP, deterministic) `[P]` after T0.2

- [ ] B.1 `[P]` Pure delta-plan in `core`: given `old..new` and the previous manifest's `previousByBlob`, compute the changed-path closure and the `planIncrementalSymbols` reuse/extract split. No IO. Property test: delta == clean full build at `new` (byte equality).
- [ ] B.2 Baseline-advance **watcher** (adapters): `fs.watch` over `refs/remotes/origin/` + `packed-refs`, debounced on an injected clock, re-resolving `resolveBaseRef` vs `manifest.baseOid`, emitting "advance to OID X" coalesced to the newest OID. Test: a burst of N advances yields exactly one pass at the tip.
- [ ] B.3 Delta-pass **runner** (adapters): composes `loadManifest`/`loadSymbolShards` → B.1 → `buildSnapshot` → `store.advance`. Idempotent; a crash mid-pass leaves the prior snapshot intact (assert atomicity).
- [ ] B.4 Wire watcher→runner per open repo; keep review-open as the fallback entry point. Test: reviews never block on a queued/running pass.
- [ ] B.5 **Overlay** generation + merge (adapters + core): generate `~/.rennet/projects/<esc>/overlays/<non-default-base-oid>/` as the `defaultOid..nonDefaultBaseOid` delta (B.1 machinery); pure merge in `core` with **overlay-wins** precedence + deletion tombstones; composite `(base, overlay)` fingerprint = the effective `projectSnapshotId`. Test: merged read equals a clean full build at the non-default base; a deleted path is omitted; overlay staleness re-derives when the base advances.
- [ ] B.6 **Knowledge delta pass** (adapters, model-backed; depends on Track E schema + the shared watcher): on advance, invalidate knowledge statements whose evidence anchors intersect the diff, run a bounded medium-model re-adjudication over {diff, invalidated statements, affected scope maps}, mine net-new; full re-rollup only on generator/schema/guideline change or accumulation threshold; budget-capped (RoutePlan/R10), debounced, merge-train-coalesced. Never blocks a review; withheld statements disclosed in the ContextManifest as invalidated-pending. Test: a review proceeds on surviving knowledge while a pass runs; invalidated statements are disclosed, not silently dropped.

## Track C — Net-novel coupling (#144) `[P]` after T0.3

- [ ] C.1 `[P]` Pure **novelty re-adjudication diff** in `core`: given two `NoveltyLedger`s, return entries whose classification changed. No IO. Test: unchanged excluded; a `conforms→novel` flip surfaced.
- [ ] C.2 Classify against the **merged** view (base+overlay, B.5) for non-default bases; pin the ledger to the composite `projectSnapshotId`. Test: a non-default-base review classifies relative to its effective baseline.
- [ ] C.3 Baseline-advance coupling (adapters): on advance mid-review, re-run the deterministic ledger at the new (re-merged) snapshot, apply C.1, mark only changed entries for Stage-2 re-adjudication; prior model output stays visible until regeneration succeeds (R29), never automatic. Test the R29 visibility rule.
- [ ] C.4 Define + validate the **feed order**: baseline material (`context.map` shards + primer) before the diff pack + novelty section. Test the ordering contract.
- [ ] C.5 Stage-2 **output-schema contract** in `core` (types + validator): every net-novel judgment cites `(projectSnapshotId, shardRef)` or a knowledge-statement id; an uncited claim validates only as a labelled hypothesis. Ship the schema; the model that fills it is deferred. Test: an uncited "novel" fails the fact schema, passes as hypothesis.

## Track D — Symbolic navigation surface (layer b, model-free) `[P]` after T0

- [ ] D.1 `[P]` `context.overview` — a file's symbol overview from the snapshot's existing per-file symbol shards (top-level symbols + signatures, no bodies). Pure `core` handler shape + backend resolution, exactly as `context.map`. **No LSP dependency** — ships on wave-1 substrate. Test: overview equals the snapshot's symbols for a file at the pinned base OID; carries freshness.
- [ ] D.2 `context.symbol` — go-to-definition over #23's LSP substrate: signature, doc, definition location + first lines, origin path, tier label (`exact`/`guess`, candidates when degraded). Consumes #23's materialization port + position mapper + degraded-result detector (do NOT re-implement). Emits no read event (noninterference property). Test: an `exact` TS answer and a `guess` tree-sitter answer both render honestly; a degraded case lists candidates, never a wrong target.
- [ ] D.3 `context.references` — find references, tier-labelled; sequenced behind D.2 per #23. Test: references at a pinned ref; capped/queued; no read event.
- [ ] D.4 Envelope + pinning: all three ride the `canvasOps@2` `{data, evidence, freshness, truncated}` envelope, pin to the same base OID / merged snapshot as `context.map`, and stay off the read/coverage projection. Test: staleness surfaces per reply; a stale pin refuses.

## Track E — LLM knowledge layer (layer c, `context.knowledge`) `[P]` after T0

- [x] E.1 `[P]` Knowledge statement schema (core, types + validator): evidence anchors, provenance, confidence, the snapshot learned-against, hypothesis-vs-confirmed label. A model-derived statement is a labelled hypothesis until confirmed. Test: an unanchored or anchor-unresolvable statement is invalid; a hypothesis renders labelled. **(`@rennet/types` knowledge types; `core/knowledge.ts` `validateKnowledge*`; `core/knowledge.test.ts`.)**
- [x] E.2 Knowledge store layout (adapters): `~/.rennet/projects/<esc>/knowledge/` local, promoted to `<repo>/.rennet/knowledge/` (rides Track A promotion/discovery/validation). Invalidation index keyed by evidence-anchor → statement. Test: a statement is invalidated with its snapshot inputs. **(`adapters/knowledge-store.ts` + test; invalidation is derived from anchor→file-blob resolution, the file inventory IS the index.)**
- [x] E.3 `context.knowledge` handler (core pure shape + backend): return statements verbatim with evidence/confidence/hypothesis labels intact; withhold (disclose as invalidated-pending) statements the current delta pass invalidated. Test: a withheld statement is disclosed, not silently absent; labels survive the round-trip. **(`core/knowledge.ts` `queryKnowledge` + `canvas-ops.ts` `context.knowledge` tool; `adapters/knowledge-backend.ts` gated accessor + test.)**
- [x] E.4 Initial enrichment (project-open, model-backed, bounded): guideline-driven mining of the initial knowledge set against the base snapshot. Feeds B.6 for incremental upkeep. Test: statements carry resolvable anchors and the snapshot they were learned against. **(`core/knowledge-generation.ts` `runKnowledgeEnrichment`; `adapters/knowledge-enrichment.ts` real harness wiring; the `runKnowledgeDeltaPass`/`runKnowledgeDeltaForRepo` half covers B.6 riding #197's `BaselineAdvanceCoordinator`. Cost harness: `adapters/knowledge-cost.real.test.ts`.)**

## T-final — Integration & validate

- [ ] TF.1 `openspec validate build-repo-map-lifecycle --strict` green.
- [ ] TF.2 Cross-track integration: advance the baseline (B) → the structural refresh + bounded knowledge pass run (B.5/B.6, E) → the pinned diff pack re-adjudicates (C) → the store the review reads is the advanced/merged one (A), the agent navigates via `context.overview/symbol/references` (D) and reads surviving knowledge via `context.knowledge` (E), none blocking a review; a non-default-base review reads base+overlay.
