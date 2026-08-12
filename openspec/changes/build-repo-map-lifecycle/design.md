# Design: Repo Map lifecycle

Design-only. Builds on the wave-1 foundation; invents no new snapshot format or classifier. It adds the **lifecycle**: where the map lives and how access travels (#141), the IDE-like symbolic surface the agents navigate with, the LLM knowledge layer, how all of it stays fresh as the reference branch moves (#143), and how the diff pack pins to the baseline to tell what is net-novel (#144). Rai resolved decisions 1-3 on 2026-08-10 and then reversed decision 4 (knowledge layer is IN v1); this design bakes all of that in and adopts codeindexer.dev's approach where it fits.

## 0. What wave 1 already gives us (do not rebuild)

- `ProjectSnapshotStore(baseDir)` — app-owned, content-addressed, atomic `advance()`, integrity-verifying `loadManifest`/`loadShard`/`loadSymbolShards`.
- `isSnapshotFresh` — freshness = `baseOid` equality + schema version, not age. `verifySnapshotIntegrity` + `ProjectContextReader.loadFresh` — the fail-closed gate.
- `planIncrementalSymbols(...)` — incremental reuse by `blobOid`, **byte-identical to a clean full build**. The delta-pass and overlay engine.
- **Per-file symbol shards** (already extracted into the snapshot) — the substrate that makes `context.overview` free (§7).
- `classifyNovelty(...)` → `NoveltyLedger` stamped with `snapshotFingerprint`+`baseOid`+`patchsetId` — Stage-1 net-novel.
- `resolveBaseRef(root)` — resolution order explicit-setting → `origin/HEAD` → `@{upstream}`.
- The `canvasOps@2` `context.*` family: `context.map`, `context.file`, `context.novelty` (pure handlers, backend-resolved), uniform envelope `{data, evidence, freshness, truncated}`, staleness on every reply (R30).

⚠️ Wave 1 keyed by `sha256Hex(git-common-dir)` so worktrees shared one entry. **Rai's storage decision replaces this** with a path-keyed local-first layout (§1); the old portable-identity/alias-matching design is **deleted**.

## 0.5 The Repo Map is THREE layers (Rai, 2026-08-10)

The user-facing "Repo Map" (R54) is one name over three distinct layers, and the **model boundary between them is load-bearing** — it is what keeps "never consume stale context" checkable:

| Layer | What it is | Model? | Freshness discipline |
|---|---|---|---|
| **(a) Structural map** | ProjectSnapshot: files/symbols/edges/tests/conventions shards, novelty ledger | **Model-free** | Hard, fail-closed. A review REQUIRES a fresh (a) at its base OID or refuses. |
| **(b) Symbolic surface** | The "IDE for the agent": go-to-def / references / symbol-overview over an LSP substrate | **Model-free** (LSP/tree-sitter) | Pinned to the same base OID; tier-labelled (`exact`/`guess`), honest degradation. |
| **(c) Knowledge layer** | LLM-reconstructed *why*: what a module does, the conventions it embodies, the intent | **Model-backed** | Soft, best-effort, never blocks a review; partial state disclosed in the ContextManifest. |

(a) and (b) are the synchronous substrate. (c) is asynchronous, uncapped, and disclosed-when-partial. Every `context.*` tool below names which layer it reads.

## 1. Storage, travel & promotion (#141 / R55 — decisions 1 & 2)

### 1.1 Local-first layout (default)

All derived layers live **local, never committed by default**, keyed by the repo's escaped absolute path:

```
~/.rennet/projects/<escaped-absolute-path>/
  config.json                       # config incl. promotion + relocation record
  map/                              # (a) default-branch BASE structural map (manifest.json + shards/)
  overlays/<non-default-base-oid>/  # (a) per-non-default-base overlays (§3)
  knowledge/                        # (c) learned statements, evidence-anchored (§8)
```

The store's `baseDir` becomes `~/.rennet/projects/`; the per-project key is `escapePath(git rev-parse --show-toplevel)`, replacing the wave-1 `sha256Hex(git-common-dir)` segment. (The LSP substrate (b) materialises refs into its own app-owned cache per #23; it is not a committed layer.)

### 1.2 The escaped-absolute-path scheme (EXACT, cross-platform)

Mirrors Claude Code's session-dir convention: the full absolute path flattened to one cross-platform-safe segment.

**`escapePath(absPath)`:** (1) resolve to the canonical absolute path; (2) replace every character in `{ '/', '\', ':' }` with `-`; (3) collapse runs of `-` into one.

**Examples:** `/Users/rai/dev/lumiere` → `-Users-rai-dev-lumiere`; `/Users/rai/navi` → `-Users-rai-navi` (matches Claude Code's verifiable form); `C:\Users\rai\navi` → `C-Users-rai-navi`; `\\srv\share\proj` → `-srv-share-proj`.

⚠️ **Micro-discrepancy to eyeball (§6.1):** the brief gave both `-Users-rai-navi` (leading dash, Claude Code's real form) and `Users-rai-dev-lumiere` (no leading dash). This follows the leading-dash form; stripping it is one line if Rai prefers.

### 1.3 Opt-in promotion (sharing)

A map can be **promoted** to be tracked in-repo, a per-project opt-in (default off): on promotion the derived layers are written into the repo on the **default branch** — `<repo>/.rennet/map/` and `<repo>/.rennet/knowledge/` — so collaborators pick them up via normal git. `config.json` records the promotion. Committing content-addressed derived data carries churn/merge/bloat cost (why it is opt-in). A committed map is **validated on discovery** (integrity + fingerprint), never trusted blind.

> Note: the coordinator's phrasing put the knowledge layer at `.rennet/knowledge/`; that is exactly the **promoted (committed)** location. The **local default** is `~/.rennet/projects/<esc>/knowledge/`, consistent with R55 keeping derived data in the app-owned store by default (§6.2 confirms).

### 1.4 Precedence

Resolve: **local** `~/.rennet/projects/<esc>/` first (yours, freshest, especially on a branch) → **committed** `<repo>/.rennet/` fallback → build locally if neither. The portable-identity problem is dissolved by construction: a committed map pertains to the repo it lives in; a local map is keyed by its path. No forge identity, no alias matching. (Mirrors codeindexer.dev's path-keying.)

### 1.5 Relocation & aliases (adopted from codeindexer.dev)

`relocate <old> <new>` updates a project's escaped-path dir **without reindexing**; aliases resolve alternative escaped paths to one project. The only concession path-keying needs.

### 1.6 Visibility switch (#14 / bead 52)

`projectContext.visibility: local | git-visible` — preview-only; never `git add`/`rm --cached`/`commit`; pre-tracked files disclosed, never restaged.

## 2. Proactive delta pass as the reference branch moves (#143) — NOW two halves

One trigger, two passes. As the reference branch moves, both the model-free structural refresh and the LLM knowledge-enrichment pass run; **neither blocks a review**.

**Shared trigger.** A baseline-advance watcher per open repo: `fs.watch` over `<git-common-dir>/refs/remotes/origin/` + `packed-refs` (event-driven, not polled) → **debounce** on an injected clock (~R35 batcher; no RxJS) → re-run `resolveBaseRef` → compare to stored `manifest.baseOid`. Moved → enqueue for the **newest OID only** (burst coalescing: a merge train collapses to one pass at the tip). Review-open stays the always-correct fallback. "Upstream main moved" and "reference branch moved" are one pipeline, two entry points.

### 2a. Structural pass (layer a — model-free, correctness-bearing)

Reuse the wave-1 incremental path exactly: `loadManifest` → `loadSymbolShards` (`previousByBlob`) → changed-path closure `old..new` → `planIncrementalSymbols` → `buildSnapshot` at `new` (assert incremental == clean-full byte equality) → `store.advance` (atomic; a crash leaves the prior snapshot intact). A review REQUIRES a fresh (a); if the proactive pass has not caught up, the on-open build serves it synchronously. No lock a review waits on.

### 2b. Knowledge pass (layer c — model-backed, best-effort, log-structured)

Adopts #143's ratified log-structured model:
- **Delta pass (common case):** on `old..new`, invalidate knowledge statements whose evidence anchors intersect the diff, then an **uncapped** pass over `{the diff, the invalidated statements, the affected scope maps}` re-adjudicates each invalidated statement and mines net-new ones. Untouched knowledge stays pinned to its original evidence (not re-run).
- **Full re-rollup (compaction):** only on generator/schema/guideline change or an accumulation threshold.
- **Run shape:** re-enrich only changed regions; debounce; coalesce the merge train; no per-pass model ceiling.
- **Never block a review.** Reviews proceed on the current snapshot + surviving knowledge; the **ContextManifest discloses which statements were withheld as invalidated-pending** (R29). Prior knowledge stays visible until regeneration succeeds; regeneration is never automatic on the review's critical path.

The model boundary is exactly here: 2a is synchronous and required; 2b is asynchronous and disclosed-when-partial.

## 3. Base + overlay for non-default bases (#143 / decision 3)

Layered, not default-only, not track-every-branch. The default-branch structural map is the **BASE**; a review against a **non-default base** generates a per-base **OVERLAY** = the deterministic `defaultOid..nonDefaultBaseOid` delta (via `planIncrementalSymbols`), stored at `~/.rennet/projects/<esc>/overlays/<non-default-base-oid>/`. **Merged read:** overlay-wins per shard key; a path deleted on the non-default base is an overlay **tombstone**; the merged view's composite `(base, overlay)` fingerprint is the pinned `projectSnapshotId`. Overlay freshness = `(defaultOid, nonDefaultBaseOid)`; if the base advances (§2a), the overlay re-derives. Knowledge (c) and the symbolic surface (b) read against the merged effective base too, so "net-novel" and "what does this module do" are relative to the baseline the review actually targets.

## 4. Net-novel coupling (#144) — Stage 2 now in v1

**Pin the diff pack:** add `projectSnapshotId` to `@rennet/types` `Patchset` (Contracts §3.1), filling the in-code stand-in `patchset.repository.baseOid`. Default-base → base fingerprint; non-default-base → composite `(base, overlay)` fingerprint. Classify against the **merged** view.

**Re-adjudication on advance (R29):** re-run the deterministic ledger at the new snapshot, diff the two ledgers, mark only classification-changed entries for Stage-2 re-adjudication; prior output stays visible until regeneration succeeds.

**Stage 2 (now v1, on the knowledge layer):** LLM design-level judgment — new pattern vs instance, duplicates an existing capability, violates/extends/contradicts a learned convention. **Hard output schema:** every net-novel judgment cites a `(projectSnapshotId, shardRef)` or a knowledge-statement id; an uncited claim is a **labelled hypothesis**. Feed order: **baseline material first** (merged shards via `context.map` + knowledge via `context.knowledge` + primer), then the diff pack with its novelty section. Keeping net-novel narrow keeps Stage-1 assertable in CI.

## 5. The symbolic navigation surface — "an IDE for the agent" (layer b; Rai's vision addendum)

Rai's goal: *"want rennet to act like an IDE and context-window saver for the orchestrator and review agents."* The Repo Map is not only a static structural map the agents read — it is the substrate for **symbol-granular retrieval on demand**, so an agent pulls exactly the definition / references / overview it needs instead of dumping whole files into its window. **Context-window economy is a primary design goal, not a side effect.**

Grow the `canvasOps@2` `context.*` family with three model-free symbolic ops, each riding the existing map-not-container envelope (`{data, evidence, freshness, truncated}`, staleness per reply):

- **`context.overview`** — a file's symbol overview (top-level symbols + signatures, no bodies), the agent's "what's in this file" without reading it. **Served straight from the snapshot's existing per-file symbol shards** — model-free, no LSP dependency, shippable in v1 on wave-1 substrate alone. The leanest context-saver.
- **`context.symbol`** — go-to-definition for a symbol: signature, doc comment, definition location + first lines, origin path, and an honest **tier label** (`exact` from an LSP answer, `guess` from tree-sitter, with candidates when degraded). Powered by #23's LSP substrate.
- **`context.references`** — find references to a symbol, tier-labelled. Sequenced behind definition (per #23: ship definition first, references `gr` behind it), but designed now.

All three are **deterministic / model-free** (LSP + tree-sitter), so the IDE surface fits v1 without touching the knowledge layer's model boundary. They pin to the same base OID / merged snapshot as `context.map`, and carry the same `exact`/`guess` honesty that maps onto our labelled-hypothesis discipline (a `guess` is never rendered as exact).

### 5.1 Relationship to #23 (LSP inspector — "XL engine substrate, not chrome")

#23 builds the **LSP engine substrate** (materialization port, `lsp-host` utility process, Tier-0 tree-sitter `tags.scm` index, TS Tier-1 `tsgo`, the degraded-result detector + readiness probe, the position mapper) **and** a human-facing **peek-then-pin inspector** UI. This proposal exposes that **same engine** as an **agent-facing tool surface** — two consumers of one substrate: the human inspector (#23) and the agent `context.symbol`/`context.references` ops (here).

- **This proposal DEPENDS ON #23's engine** for `context.symbol` and `context.references` — it does **not** subsume or re-implement it. The materialization port, tier labels, and degraded-result detector are #23's; we consume them behind the `context.*` ports.
- **`context.overview` is independent of #23** — it reads the snapshot's symbol shards, so the leanest context-saver ships even before #23's LSP engine lands.
- The honesty contract is shared: #23's `exact`/`guess`/candidate-list tier labels surface verbatim in the agent ops. A definition open by an agent, like the human inspector, **emits no read event and raises no coverage obligation** (#23's noninterference property applies to the agent surface too).

## 6. Knowledge layer detail (layer c; #14 knowledge half — now v1)

`context.knowledge` serves LLM-reconstructed understanding: what a module does, the conventions it embodies, the reconstructed *why*. Per #14: guideline-driven; every learned statement carries **evidence anchors, provenance, confidence, and the snapshot it was learned against**; model-derived knowledge is a **labelled hypothesis until confirmed**; a statement is invalidated with its snapshot inputs. `context.knowledge` returns statements **verbatim** with evidence/confidence/hypothesis labels intact, and withholds (discloses as invalidated-pending) any statement whose inputs the current delta pass invalidated. Storage: `~/.rennet/projects/<esc>/knowledge/` local, promoted to `<repo>/.rennet/knowledge/`. This is the only layer where a model writes; it never enters (a) or (b).

**What of #14 remains OUT:** the multi-repo `WorkspaceContext` composition (knowledge stays per-repo) — filed with #142. Everything else of #14 (deterministic snapshot, `context.map/file`, knowledge layer, `context.knowledge`, visibility contract) is in v1.

## 7. Dependency-arrow compliance

- `core` (node-free, pure): `escapePath`; the delta-plan + overlay-merge/tombstone logic; the novelty re-adjudication diff; the `projectSnapshotId` field; the Stage-2 novelty output schema + validator; the pure `context.overview`/`context.symbol`/`context.references`/`context.knowledge` handler shapes (backend-resolved, exactly as `context.map` is today).
- `adapters` (store/git/fs/model-backed): path-keyed store; promotion writer + validate-on-discovery reader; `relocate`/aliases; the baseline-advance watcher; the structural + knowledge delta runners; the overlay runner; the LSP-substrate ports (consuming #23); the uncapped knowledge-enrichment model calls; the visibility switch.
- `ui`: reads only over `canvasOps@2`.
- **Model boundary is explicit:** layers (a) structural and (b) symbolic are model-free; only layer (c) knowledge (and net-novel Stage 2, which reads it) calls a model, always off the review's critical path.

## 8. Resolved policy values (Rai, 2026-08-12)

1. **Escaped paths keep the leading dash** used by Claude Code.
2. **Knowledge stays local-first** at `~/.rennet/projects/<esc>/knowledge/`; promotion writes `<repo>/.rennet/knowledge/`.
3. **Knowledge-pass model budget is uncapped.** Spend as needed; there is no per-advance ceiling.
4. **Overlay and knowledge retention uses the design-default reaping policy:** LRU and drop when the base OID is unreachable.
5. **Promotion is base-only.** Overlays remain local.
