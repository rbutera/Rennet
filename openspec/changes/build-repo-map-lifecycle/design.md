# Design: Repo Map lifecycle

Design-only. This builds directly on the wave-1 foundation; it invents no new snapshot format, no new store, and no new novelty classifier. It adds the **lifecycle** around them: where the map lives and how access travels, how it stays warm as the reference branch moves, and how the diff pack pins to the baseline to tell what is genuinely net-novel.

## 0. What wave 1 already gives us (do not rebuild)

- `ProjectSnapshotStore(baseDir)` — app-owned, keyed by `sha256Hex(repoKey)`, atomic `advance()`, integrity-verifying `loadManifest`/`loadShard`/`loadSymbolShards`. It is already the option-C store from #141.
- `isSnapshotFresh(manifest, requestedBaseOid)` — freshness = `baseOid` equality + schema version. Not age.
- `verifySnapshotIntegrity` + `ProjectContextReader.loadFresh(repoKey, requestedBaseOid)` — the fail-closed gate: stale/absent/corrupt → typed refusal, never a wrong-baseline read.
- `planIncrementalSymbols(eligible, previousByBlob, extractorId)` — incremental symbol reuse by `blobOid`, **byte-identical to a clean full build**. This is the delta-pass engine.
- `classifyNovelty(snapshot, patchset)` → `NoveltyLedger` recording `snapshotFingerprint` + `baseOid` + `patchsetId` — Stage-1 net-novel, already coupled to the baseline it ran against.
- `resolveBaseRef(root)` — resolution order explicit-setting → `origin/HEAD` → `@{upstream}`, returning `{repoKey, baseRef, baseOid, baseRefResolution}`. This is the baseline-advance detector's input.
- `snapshotStoreFor(userDataDir)` = `new ProjectSnapshotStore(join(userDataDir, "snapshots"))` — the store already lives under Electron `userData`, app-owned (R27/R55).

## 1. Storage & travel (#141 / R55)

**The map does not travel; access does.** Every worktree of a repo shares one `git-common-dir`, so `resolveBaseRef` yields the same `repoKey` from any worktree, and the store's `sha256Hex(repoKey)` directory is shared. No symlink, no per-worktree rebuild, no mutation of the working tree. This is the direct consequence of the wave-1 key choice and this proposal ratifies it rather than changing it.

**The R27→R55 split (formalise, do not re-litigate):**
- Derived Repo Map (snapshot manifest + content-addressed shards, and later the knowledge layer) → app-owned store, keyed by repo identity. Rebuildable, never committed by default.
- Human-authored config (`project.jsonc`, conventions, guideline docs) → repo-local `.rennet/`, committable, under the trust gate (R31).
- #14's documented `.rennet/snapshot/manifest.json` path is superseded: derived shards are in the store, not `.rennet/`.

**RepoRecord identity (the portability seam — a decision for Rai, §5).** Today `repoKey` is a machine-local absolute path (`realpath(git-common-dir)`). R19's durable identity is the **RepoRecord** = uuidv7 + aliases (common-dir, forge identity, root-commit hint). For a purely local store the path alias is sufficient and is what wave 1 uses. It becomes insufficient the moment a map is **discovered from a committed mirror** or the repo moves on disk: the path differs, so the store key differs. The design introduces a `RepoRecord` resolver in adapters that produces the aliases; the store continues to key by the common-dir alias for the local map, and discovery matches a mirrored map by a **portable** alias (forge identity or root-commit hint), not the path.

**Discover-a-committed-map (new).** On project open, if the repo contains a committed map under `.rennet/` (the opt-in mirror a teammate produced), Rennet reads it and **validates on discovery**: re-verify shard integrity (bytes hash to digest) and fingerprint against the committed base OID via the existing `verifySnapshotIntegrity`. A map that fails validation is ignored (fall back to local build), never trusted blind (R55). A valid discovered map seeds the local store so the reviewer starts warm.

**Opt-in mirror export (new).** A per-project/workspace setting, **default off**. When on, a deliberate user act writes the current store's manifest + shards into `.rennet/` for commit. This is the only path that puts derived data into git; it carries churn/merge/bloat cost, which is why it is opt-in. Format and refresh cadence are a decision for Rai (§5).

**`projectContext.visibility: local | git-visible` (from #14 / bead 52).** Switching previews the filesystem diff and changes only Rennet-owned exclusion state; it never runs `git add`, `git rm --cached`, or `git commit`; already-tracked files stay tracked and are disclosed honestly. This is the trust boundary that keeps "Rennet never stages or commits" literal.

## 2. Proactive delta pass (#143, MVP — deterministic half)

**Correctness is not at stake here; latency is.** The review path already refuses a stale snapshot (`loadFresh` pins to `patchset.repository.baseOid`) and the on-open path builds synchronously if the store is cold. So the proactive pass can never make a review *wrong*; if it has not run, the on-open build covers it. The proactive pass exists so that main advancing does not make the next review pay a cold rebuild, and so the store does not drift unboundedly stale.

**Trigger.** A baseline-advance watcher, per open repo:
1. Watches the ref that `resolveBaseRef` resolves (default branch): `fs.watch` over `<git-common-dir>/refs/remotes/origin/` + `packed-refs` (adapters; `QueueDirectories`-style, event-driven not polled, per Rule 65's preference).
2. On a filesystem event, **debounce** to a quiet window (injected clock, ~R35 hand-rolled batcher discipline — no RxJS), then re-run `resolveBaseRef`.
3. Compare the resolved `baseOid` to the stored `manifest.baseOid` (`isSnapshotFresh`). If unchanged, do nothing. If moved, enqueue a delta pass **for the newest OID only** (burst coalescing: a merge train of N advances collapses to one pass at the tip; never chase intermediate OIDs).
4. Review-open remains the always-correct fallback entry point: it re-resolves and builds if the watcher has not caught up.

"Upstream main moved" and "reference branch moved" are **one pipeline, two entry points**: both reduce to "the resolved base OID changed"; the watcher covers the default branch proactively, review-open covers any per-review base (see §5 for the non-default-base scope question).

**Algorithm (deterministic delta pass).** Reuse the wave-1 incremental path exactly:
1. `loadManifest(repoKey)` → previous manifest; `loadSymbolShards(manifest)` → `previousByBlob`.
2. Compute the changed-path closure `old..new` (git range), materialise the new structural inputs at `new`.
3. `planIncrementalSymbols(eligibleFilesAtNew, previousByBlob, extractorId)` → reuse unchanged blobs verbatim, re-extract only changed ones.
4. `buildSnapshot(...)` at `new` → `BuiltSnapshot`; **assert incremental == clean-full-build byte equality** (already a wave-1 invariant; the delta pass must preserve it).
5. `store.advance(built)` — atomic temp+rename; the old snapshot stays fully readable until the final rename. A crash mid-pass leaves the prior snapshot intact.

**Never block review.** While a delta pass is queued or running, reviews proceed on the current store via `loadFresh`. There is no lock a review can wait on. (The knowledge-layer half of #143 — disclosing invalidated-pending statements in the ContextManifest — is deferred; the deterministic snapshot has no "partial" state: it is either advanced atomically or not.)

## 3. Net-novel coupling (#144)

**Pin the diff pack to its baseline.** Add `projectSnapshotId` to `@rennet/types` `Patchset` (Contracts §3.1). Today `NoveltyLedgerReader.classify` stands in `patchset.repository.baseOid` and the in-code comment flags the missing field; this change fills it. The Stage-1 ledger already stamps `snapshotFingerprint` + `baseOid` on its output, so once the Patchset carries `projectSnapshotId` the pin is end-to-end: a ledger is only ever valid for the exact snapshot it names.

**Re-adjudication on baseline advance (R29).** When the baseline advances mid-review, the diff pack's novelty section is potentially-invalid, not silently kept:
1. Re-run the **deterministic** ledger against the new snapshot (cheap, no model).
2. Diff the two ledgers: an entry whose classification (`novel` / `extends` / `conforms`) is unchanged stays adjudicated; only **classification-changed** entries are marked for Stage-2 re-adjudication.
3. Prior model output stays visible until model-backed regeneration succeeds (R29); regeneration is never automatic.

This "novelty re-adjudication diff" is a pure function of two `NoveltyLedger`s and belongs in `core`.

**Feed order.** To the review agents / orchestrator, always: **baseline material first** (snapshot shards via `context.map`, primer), **then the diff pack with its novelty section**. A model cannot judge net-novelty before it has the baseline in hand.

**Stage-2 output-schema contract (design target; adjudicator deferred).** The Stage-2 LLM judgment (is this a new pattern or an instance of an existing one; does it duplicate an existing capability; does it violate/extend/contradict a learned convention) is bound by a hard output schema: **every net-novel judgment cites a `(projectSnapshotId, shardRef)` or a knowledge-statement id.** An uncited novelty claim is emitted as a **labelled hypothesis**, never as a fact. This schema (types + validator) is defined and shippable in v1 in `core`; the model that fills it runs on the deferred knowledge layer. Keeping net-novel narrow (not general diff understanding) is what keeps Stage 1 assertable in CI.

## 4. Dependency-arrow compliance

- `core` (node-free, pure): the delta-plan/changed-closure logic (reusing `planIncrementalSymbols`), the novelty re-adjudication diff, the `projectSnapshotId` field, the Stage-2 novelty output schema + validator. No `fs`, no `git`, no model.
- `adapters` (store/git/fs-backed): the `RepoRecord` resolver, the baseline-advance watcher, the delta-pass runner (composes existing store methods), the committed-map discovery/validation reader, the mirror-export writer, the visibility switch. Every side effect lives here.
- `ui`: reads only over the `canvasOps@2` bridge (`context.map/file/novelty`); never runs a slicer, a watcher, or the store.
- The snapshot and the Stage-1 ledger stay **model-free** (R30/R54): no model turn may enter either deterministic path — this is the checkability that makes "never consume stale context" provable.

## 5. Decisions that need Rai (the friction, not a clean story)

1. **Portable identity for a discovered/shared map.** The store keys by `realpath(git-common-dir)` — machine-local. A discovered or mirrored map made on another machine (or after the repo moved on disk) has a different path key. Which RepoRecord alias is the portable match for discovery — forge identity, root-commit hint, or both — and does the committed mirror embed the RepoRecord aliases so a peer can match it? Wave 1 never had to face this because everything was local-only; the discover-a-committed-map direction forces the question.
2. **Mirror format + refresh cadence.** A mirrored map is content-addressed derived data in git — it churns on every main advance. Is the mirror the full shard tree, or a compacted single-artifact export? And is it re-mirrored manually (a deliberate act each time) or auto-refreshed on advance (reintroducing the churn R55 opt-out was meant to avoid)? R55 pins "opt-in, default off, validated on discovery" but not the shape or the cadence.
3. **Scope of proactive tracking: default branch only, or arbitrary reference branches?** The watcher proactively maintains the **default-branch** snapshot. A review whose base is a *non-default* reference branch has its base built on-open and is not proactively tracked (tracking every branch is unbounded). Confirm this is the intended MVP scope, and that "the reference branch moved" for a non-default base is served by the on-open gate rather than a second watcher.
4. **Delta-pass execution envelope.** Confirm the v1 proactive pass is deterministic-only (no model turn, no user-visible progress required) and runs as a bounded background worker sharing the trigger the future knowledge delta-pass will use. This keeps the model-free guarantee literal and the trigger reusable.
