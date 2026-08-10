## Why

Wave 1 built the Repo Map **foundation**: a deterministic, model-free `ProjectSnapshot` (`packages/core/src/project-snapshot.ts`), an app-owned content-addressed `ProjectSnapshotStore` (`packages/adapters/src/project-snapshot-store.ts`), a fail-closed freshness/integrity gate (`ProjectContextReader.loadFresh`), a deterministic **Stage-1 novelty ledger** (`classifyNovelty` + `NoveltyLedgerReader`), and snapshot-on-review-open wired live (`live-review-backend.ts`, #13). `context.map` / `context.file` / `context.novelty` already read through it.

What is NOT yet designed is the Repo Map **lifecycle** — the three ratified directions (R54/R55, issues #141/#143/#144), whose four open decisions Rai resolved on 2026-08-10:

- **#141 storage/travel** — Rai's decision: derived maps live LOCAL by default under `~/.rennet/projects/<escaped-absolute-path>/map/`, keyed by the repo's escaped absolute path (the Claude-Code session-dir convention); a map can be **promoted** to be tracked in-repo on the default branch for collaborators; local resolves first, committed is the fallback. This **dissolves** the portable-identity/alias-matching problem (a committed map pertains to the repo it lives in, by construction) and replaces wave-1's `git-common-dir`-hash keying.
- **#143 proactive delta update** — nothing yet detects that the reference branch moved and refreshes the snapshot ahead of the next review. Rai's decision: deterministic-only for v1, and non-default review bases are handled by a **base + overlay** composition (default-branch map as base, per-branch overlay on top), not default-only and not track-every-branch.
- **#144 net-novel coupling** — Stage 1 exists but `Patchset` lacks the `projectSnapshotId` Contracts §3.1 requires, there is no re-adjudication-on-advance path (R29), no feed order, and no Stage-2 citation output-schema.

Rai then reframed what the Repo Map fundamentally IS: **three layers, all in v1** — (a) the deterministic structural map (model-free), (b) an LSP-backed **symbolic navigation surface** — "an IDE for the agent" that saves the orchestrator's and review agents' context windows by serving symbol-granular context on demand (model-free), and (c) the **LLM knowledge layer** (`context.knowledge`), pulled INTO v1 (reversing the earlier defer). Layers (a) and (b) are model-free; only (c) crosses the model boundary.

Rai's directive: **adopt codeindexer.dev's approach** — local-first plain files keyed by project path, incremental per-changed reindex, per-result freshness (indexed-commit vs HEAD), git-committable sharing, `relocate`/aliases, AND its "IDE for the agent" symbolic surface (`search_code`, `read_chunk`, `find_callers`/`find_callees`, `find_references`, `find_by_signature`, `rank_functions` over MCP) — where it fits, diverging on our local-first `~/.rennet` + opt-in promotion, and on HOW we do semantics: our knowledge layer is LLM-reconstructed evidence-anchored *why*, not codeindexer's embedding/vector semantic search + agent-authored memory cards.

This change is a **design-only proposal** (no implementation) for the whole lifecycle on the wave-1 foundation.

## What Changes

- **Storage, travel & promotion (#141).** Move the store to `~/.rennet/projects/`, keyed by the escaped absolute path of the repo root (exact cross-platform escaping specified). Local by default, never committed; **opt-in promotion** writes `map/` into `<repo>/.rennet/map/` on the default branch; **local-first precedence**, committed fallback; a committed map is validated on discovery, never trusted blind. Adopt codeindexer's **`relocate`/aliases** as the path-keying escape hatch. Specify the `projectContext.visibility: local | git-visible` switch (preview-only; never stages/commits). Delete the forge-slug/root-commit alias-matching design.
- **Proactive delta pass (#143, MVP, deterministic).** A debounced baseline-advance watcher re-resolves the default-branch ref and, on OID movement, enqueues a deterministic changed-path-closure rebuild via `planIncrementalSymbols`, coalescing bursts to the newest OID and advancing atomically. Reviews never block on it (correctness stays with the on-open gate).
- **Base + overlay for non-default bases (#143).** The default-branch map is the base; a review against a non-default base generates a per-base overlay (the `defaultOid..nonDefaultBaseOid` delta), and reads merge base+overlay with **overlay-wins** precedence and tombstones for deletions. The merged view's composite fingerprint is the pinned `projectSnapshotId`.
- **Symbolic navigation surface (layer b).** Grow the `context.*` family with model-free ops: `context.overview` (a file's symbol overview, served straight from the snapshot's existing symbol shards — no LSP dependency, leanest v1 context-saver), `context.symbol` (go-to-definition, tier-labelled `exact`/`guess`) and `context.references` (tier-labelled, sequenced behind definition). `context.symbol`/`context.references` consume #23's LSP engine substrate; this proposal exposes that engine as an agent tool surface (it does not subsume #23).
- **LLM knowledge layer (layer c, `context.knowledge`).** Now in v1 (was #14's deferred half): evidence-anchored, confidence-labelled learned statements (what a module does, its conventions, the reconstructed *why*), stored at `~/.rennet/projects/<esc>/knowledge/` (promoted to `<repo>/.rennet/knowledge/`), served verbatim with hypothesis labels intact.
- **Net-novel coupling (#144).** Add `projectSnapshotId` to `Patchset`; classify against the merged view; on baseline advance re-run the deterministic ledger and re-adjudicate only classification-changed items (R29); feed baseline-first; Stage-2 LLM adjudication (citation-required output schema) now ships in v1 on the knowledge layer.
- **Knowledge delta pass (layer c).** The delta pass is no longer deterministic-only: as the reference branch moves it runs the model-free structural refresh AND a bounded LLM knowledge-enrichment pass (invalidation-scoped, changed-regions-only, debounced, merge-train-coalesced, budget-capped, on the user's own subscription), which never blocks a review and discloses withheld statements in the ContextManifest.

## Capabilities

### Added Capabilities

- `repo-map-storage`: the local-first `~/.rennet/projects/<escaped-path>/` layout, the exact escaping scheme, opt-in in-repo promotion, local-first precedence, validate-on-discovery, `relocate`/aliases, and the visibility switch.
- `repo-map-delta-pass`: proactive baseline-advance detection and the deterministic, burst-coalesced, atomically-advancing delta rebuild that never blocks a review, plus the base+overlay composition for non-default bases.
- `repo-map-net-novel`: the diff-pack-to-baseline pin (`projectSnapshotId` on `Patchset`), classification against the merged view, re-adjudication on advance, feed order, and the citation-required Stage-2 output schema (adjudicator in v1 on the knowledge layer).
- `repo-map-symbolic-surface`: the model-free "IDE for the agent" ops — `context.overview` (from snapshot shards), `context.symbol`, `context.references` — tier-labelled, context-window-saving, riding the `canvasOps@2` envelope; consumes #23's LSP engine.
- `repo-map-knowledge`: the LLM knowledge layer and `context.knowledge` — evidence-anchored, confidence/hypothesis-labelled statements, invalidated with their snapshot inputs, plus the bounded knowledge delta pass.

## Impact

- **New design, no runtime code in this change** (proposal only). Named build targets:
  - Core (node-free): `escapePath`; the delta-plan reusing `planIncrementalSymbols`; the overlay-merge + tombstone logic; the novelty re-adjudication diff; the `projectSnapshotId` field on `@rennet/types` `Patchset`; the Stage-2 novelty output schema + validator.
  - Adapters (store/git/fs): the path-keyed store layout under `~/.rennet/projects/`; the promotion writer + validate-on-discovery reader; `relocate`/aliases; the baseline-advance watcher (debounced, injected clock); the delta-pass and overlay runners; the visibility switch.
  - Contracts: R55 formalised (path-keyed local-first + promotion), #14's `.rennet/snapshot/manifest.json` path superseded by `~/.rennet/projects/<esc>/map/` (+ promoted `<repo>/.rennet/map/`), and Contracts §3.1 `projectSnapshotId` filled.
- Dependency arrows preserved: deterministic logic in `core` (pure), all store/git/fs in `adapters`, `ui` reads only over `canvasOps@2`. The snapshot + Stage-1 ledger stay model-free (R30/R54).
- ⚠️ **Trade-off Rai should know:** path-keying gives each worktree its own local entry (wave-1's "worktrees share one store entry" property is retired). Cross-worktree/cross-machine sharing now comes from the committed promoted map (or a cheap deterministic rebuild), not a shared store entry. This is the simplicity Rai chose; `relocate`/aliases cover the repo-moved case.

## Deferred (named, out of scope for v1)

- **Nested / submodule / monorepo maps (#142) + multi-repo `WorkspaceContext`.** Maps compose by-reference (identity + pinned OID + digest); the multi-repo workspace composition and submodule gitlink composition are a separate change, and knowledge stays per-repo. v1 is one git repo, one map (+ its overlays). This is the one substantial part of #14 that stays out.
- **`context.references` (`gr`) sequencing.** Per #23, the definition peek ships first and reference browsing is sequenced behind it; `context.references` is designed here but its build lands after `context.symbol`. Not a scope cut — a sequencing note.

Everything else — the deterministic structural map, the symbolic surface, AND the LLM knowledge layer + `context.knowledge` + Stage-2 net-novel adjudication — is **in v1** (Rai reversed the earlier knowledge-layer defer on 2026-08-10).
