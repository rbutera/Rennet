## Why

Wave 1 built the Repo Map **foundation**: a deterministic, model-free `ProjectSnapshot` (`packages/core/src/project-snapshot.ts`), an app-owned content-addressed `ProjectSnapshotStore` keyed by repo identity (`packages/adapters/src/project-snapshot-store.ts`), a fail-closed freshness/integrity gate (`ProjectContextReader.loadFresh`), a deterministic **Stage-1 novelty ledger** (`classifyNovelty` + `NoveltyLedgerReader`), and snapshot-on-review-open wired live (`live-review-backend.ts`, #13). `context.map` / `context.file` / `context.novelty` already read through it.

What is NOT yet designed is the Repo Map **lifecycle** — the three ratified directions from Rai's 2026-08-09 decision (R54/R55, issues #141/#143/#144):

- **#141 storage/travel** is only half-realised. The store is already app-owned and keyed by `sha256Hex(repoKey)` where `repoKey = realpath(git-common-dir)`, so worktrees of one repo already share one entry. But the R27→R55 amendment (derived data leaves `.rennet/`), the **discover-a-committed-map** path, the **opt-in mirror export**, and the `projectContext.visibility` switch are unbuilt, and the machine-local path key has no portable-identity story for a discovered/shared map.
- **#143 proactive delta update** does not exist: nothing detects that the reference branch moved and refreshes the snapshot ahead of the next review. Today the snapshot is only (re)built lazily on review-open. As main advances, every review pays a cold rebuild.
- **#144 net-novel coupling** is half-built. Stage 1 (deterministic ledger) exists and already records `snapshotFingerprint` + `baseOid` + `patchsetId`, but the `Patchset` does not yet carry the `projectSnapshotId` field Contracts §3.1 requires (the reader stands in `patchset.repository.baseOid`, flagged in-code), there is no re-adjudication-on-baseline-advance path (R29), no defined feed order, and no Stage-2 citation output-schema contract.

This change is a **design-only proposal** (no implementation) for the whole lifecycle sitting on the wave-1 foundation.

## What Changes

- **Storage & travel (#141).** Ratify the store as the durable home of the derived Repo Map, keyed by `RepoRecord` identity so all worktrees of a repo resolve to one entry and travel is free (no per-worktree rebuild, no symlink). Amend R27 per R55: `.rennet/` keeps human-authored config plus an optional mirrored map; derived shards + manifest live app-owned. Add a **discover-a-committed-map** path (validated on discovery — integrity + fingerprint re-checked, never trusted blind) and an **opt-in mirror export** (default off, a deliberate user act). Specify the `projectContext.visibility: local | git-visible` switch (preview-only; never `git add`/`rm --cached`/`commit`).
- **Proactive delta pass (#143, MVP).** A debounced baseline-advance watcher re-resolves the default-branch ref, and on OID movement enqueues a **deterministic** delta pass over the changed-path closure using the existing incremental machinery (`planIncrementalSymbols`), coalescing bursts to the newest OID and advancing the store atomically. Reviews never block on it: correctness is always guaranteed by the on-open fail-closed gate; the proactive pass is a latency/warmth optimisation. The v1 delta pass is deterministic-only; the LLM knowledge-layer delta pass is deferred (see Deferred).
- **Net-novel coupling (#144).** Add `projectSnapshotId` to `Patchset` (Contracts §3.1) so the diff pack pins to the exact baseline it was computed against. Define the coupling/invalidation behaviour (R29): on baseline advance, re-run the deterministic ledger first, and mark only classification-changed items for Stage-2 re-adjudication. Define the feed order (baseline material first, then the diff pack with its novelty section) and the **Stage-2 output-schema contract**: every net-novel judgment cites a `(projectSnapshotId, shard ref)` or a knowledge-statement id; an uncited claim is a labelled hypothesis. v1 ships Stage 1 + coupling + the schema contract; the Stage-2 LLM adjudicator runs on the deferred knowledge layer.

## Capabilities

### Added Capabilities

- `repo-map-storage`: the derived Repo Map's app-owned, repo-identity-keyed home; worktree/branch travel by shared identity; the R27→R55 split; discover-a-committed-map (validated) and opt-in mirror; the local/git-visible visibility switch.
- `repo-map-delta-pass`: proactive baseline-advance detection and the deterministic, burst-coalesced, atomically-advancing delta rebuild that keeps the store warm without ever blocking or gating a review.
- `repo-map-net-novel`: the diff-pack-to-baseline pin (`projectSnapshotId` on `Patchset`), re-adjudication on baseline advance, feed order, and the citation-required Stage-2 output schema.

## Impact

- **New design, no runtime code in this change** (proposal only). Named build targets for the follow-on:
  - Core (node-free) gains: baseline-advance/delta-plan pure logic reusing `planIncrementalSymbols`; a `projectSnapshotId` field on `@rennet/types` `Patchset`; a pure novelty re-adjudication-diff (which ledger entries changed classification across two snapshots); the Stage-2 novelty output schema (types + validator).
  - Adapters (store-backed) gain: a `RepoRecord` resolver + portable aliases; a baseline-advance watcher (git-ref watch, debounced, injected clock per R35's coalescing discipline); a delta-pass runner that composes existing `loadManifest`/`loadSymbolShards`/`buildSnapshot`/`advance`; a committed-map discovery+validation reader; a mirror-export writer; the `projectContext.visibility` switch.
  - Contracts: amends R27 (formalised by R55), updates #14's `.rennet/snapshot/manifest.json` path expectation, and fills the Contracts §3.1 `projectSnapshotId` field.
- Dependency arrows preserved: all deterministic logic stays in `core` (pure, no IO); every store/git/fs touch lives in `adapters`; `ui` reads only over the `canvasOps@2` bridge. The snapshot stays model-free (R30/R54): no model turn enters the deterministic snapshot or Stage-1 ledger path.

## Deferred (named, out of scope for v1)

- **LLM knowledge layer + `context.knowledge` (#14 knowledge half).** v1 serves the **deterministic** snapshot only. The knowledge-layer delta pass (invalidation-scoped LLM re-adjudication of learned statements) shares #143's trigger but is deferred; the delta-pass design here is built so the knowledge pass slots onto the same baseline-advance entry point later.
- **Stage-2 net-novel LLM adjudication (#144 model half).** v1 ships the deterministic ledger, the pin, the re-adjudication-diff, the feed order, and the citation output-schema *contract*. The model that emits cited net-novel judgments runs on the deferred knowledge layer.
- **Nested / submodule / monorepo maps (#142).** Maps compose by-reference (identity + pinned OID + digest); the multi-repo `WorkspaceContext` and submodule gitlink composition are a separate change. v1 is one git repo, one map.
