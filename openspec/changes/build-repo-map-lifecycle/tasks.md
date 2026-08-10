# Tasks: Repo Map lifecycle

Dependency-ordered. Three tracks (Storage, Delta-pass, Net-novel) are largely independent and **parallelize across worktrees** after the shared foundation task (T0). Within a track, order is sequential. `[P]` marks a task that can run concurrently with the other tracks' `[P]` tasks in its own worktree.

## T0 — Shared foundation (do first, blocks the `[P]` tracks)

- [ ] T0.1 Resolve the four §5 decisions with Rai (portable identity, mirror format+cadence, proactive scope, execution envelope). Record answers in the change before building — several tasks below branch on them.
- [ ] T0.2 Add `projectSnapshotId` to `@rennet/types` `Patchset` (Contracts §3.1) and thread it through the diff-capture path so a Patchset is stamped with the snapshot it was computed against. Update `NoveltyLedgerReader.classify` to pin on `patchset.projectSnapshotId` (removing the `repository.baseOid` stand-in). Core + types only; no behaviour change to the classifier. **Blocks Net-novel track.**
- [ ] T0.3 Add a `RepoRecord` resolver in adapters (uuidv7 + aliases: common-dir, forge identity, root-commit hint) sitting in front of the store key. Local map keeps keying by the common-dir alias (byte-compatible with today). **Blocks Storage track's discovery path.**

## Track A — Storage & travel (#141) `[P]` after T0

- [ ] A.1 `[P]` Formalise the R27→R55 split in code + docs: derived shards/manifest are store-owned; `.rennet/` holds human config (+ optional mirror). Update #14's `.rennet/snapshot/manifest.json` path expectation. Assert worktrees of one repo resolve to one store entry (test over a real worktree pair).
- [ ] A.2 Committed-map **discovery + validation** reader (adapters): on open, detect a `.rennet/` mirrored map, re-verify integrity + fingerprint via `verifySnapshotIntegrity`, match by portable RepoRecord alias (per T0.1), seed the local store on success, ignore on failure. Test: a corrupted/mismatched committed map is ignored, never served.
- [ ] A.3 Opt-in **mirror export** writer (adapters), default off: a deliberate user act writes the current store manifest+shards into `.rennet/` in the format fixed by T0.1. Test: default-off leaves `.rennet/` untouched; on-export writes a valid, re-discoverable map.
- [ ] A.4 `projectContext.visibility: local | git-visible` switch: preview the filesystem diff, change only Rennet-owned exclusion state, never `git add`/`rm --cached`/`commit`; pre-tracked files reported, never restaged. Test the "leaves git status unchanged" and "index untouched on switch" invariants.

## Track B — Proactive delta pass (#143 MVP, deterministic) `[P]` after T0

- [ ] B.1 `[P]` Pure delta-plan in `core`: given `old..new` and the previous manifest's `previousByBlob`, compute the changed-path closure and the `planIncrementalSymbols` reuse/extract split. No IO. Property test: delta result == clean full build at `new` (byte equality — the wave-1 invariant, re-asserted at the plan boundary).
- [ ] B.2 Baseline-advance **watcher** (adapters): `fs.watch` over `refs/remotes/origin/` + `packed-refs`, debounced on an injected clock, re-resolving `resolveBaseRef` and comparing to `manifest.baseOid`. Emits a "advance to OID X" signal, coalesced to the newest OID. Test: a burst of N advances yields exactly one pass at the tip.
- [ ] B.3 Delta-pass **runner** (adapters): composes `loadManifest`/`loadSymbolShards` → B.1 plan → `buildSnapshot` → `store.advance`. Idempotent; a crash mid-pass leaves the prior snapshot intact (assert atomicity via the existing temp+rename path).
- [ ] B.4 Wire the watcher→runner per open repo; keep review-open as the fallback entry point (no change to the on-open build, which already guarantees correctness). Test: reviews never block on a queued/running pass; an in-flight pass is invisible to `loadFresh`.

## Track C — Net-novel coupling (#144) `[P]` after T0.2

- [ ] C.1 `[P]` Pure **novelty re-adjudication diff** in `core`: given two `NoveltyLedger`s (old snapshot, new snapshot), return the entries whose classification changed. No IO. Test: unchanged classifications are excluded; a `conforms→novel` flip is surfaced.
- [ ] C.2 Baseline-advance coupling (adapters): on advance mid-review, re-run the deterministic ledger (`NoveltyLedgerReader.classify` at the new snapshot), apply C.1, mark only changed entries for Stage-2 re-adjudication. Prior model output stays visible until regeneration succeeds (R29); regeneration never automatic. Test the R29 visibility rule.
- [ ] C.3 Define + validate the **feed order** in the context-pack assembly: baseline material (`context.map` shards + primer) before the diff pack + its novelty section. Test the ordering contract.
- [ ] C.4 Stage-2 **output-schema contract** in `core` (types + validator): every net-novel judgment cites `(projectSnapshotId, shardRef)` or a knowledge-statement id; an uncited claim validates only as a labelled hypothesis. Ship the schema; the model that fills it is deferred (knowledge layer). Test: an uncited "novel" fails the fact schema and passes only as hypothesis.

## T-final — Integration & validate

- [ ] TF.1 `openspec validate build-repo-map-lifecycle --strict` green.
- [ ] TF.2 Cross-track integration test: advance the baseline (Track B) → the pinned diff pack's novelty re-adjudicates (Track C) → the store the review reads is the advanced one (Track A travel), all without blocking a review.
