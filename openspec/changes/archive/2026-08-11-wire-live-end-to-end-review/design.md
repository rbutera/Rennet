# Design

## The integration gap, precisely

`CanvasOpsBackend` (`packages/core/src/canvas-ops.ts`) is a 17-accessor port: `identity`, `freshness`, `angles`, `canvas`, `view`, `element`, `thread`, `hunk`, `searchDiff`, `decomposition`, `runLedger`, `provenance`, `planRecompute`, `projectMap`, `fileContext`, `novelty`, `applyEffects`. The pure `canvasOps@2` tool surface reads and writes exclusively through it. Two facts make it fake-only today:

1. The only full implementation is the test fake at `packages/core/src/canvas-ops.test.ts:178`.
2. The two merged Repo-Map adapters are PARTIAL by design. `projectContextBackend(reader, resolve)` returns just `{ projectMap, fileContext }`; `noveltyBackend(reader, resolve)` returns just `{ novelty }`. Each header says the same thing: spread the part "into a full `CanvasOpsBackend` (with the canvas/diff/run accessors)". Nothing builds those canvas/diff/run accessors from live state, and nothing supplies real `resolve()` functions.

`attachOrchestratorSession(backend, config)` (`packages/adapters/src/orchestrator-session-server.ts`) already composes `bootOrchestratorSession` + `createCanvasOpsServer(backend)` into `{ session, mcpServer }`. It just needs a real `backend` and a caller. Desktop is not that caller today (`grep` for `attachOrchestratorSession`/`createCanvasOpsServer` in `apps/desktop/src` returns nothing).

## Where the production backend lives (the dependency arrows decide it)

The arrows (`AGENTS.md`): `adapters` may import `core` and Node; `core` must NOT import `adapters`. The canvas/diff/run accessors are pure functions of the in-memory `Review` + active `Patchset` + recorded run state — they belong in **core**. The `projectMap`/`fileContext`/`novelty` slices are store-backed and live in **adapters**. So the composition is two-layer:

- **Core:** `reviewBackendCore(state): Omit<CanvasOpsBackend, "projectMap" | "fileContext" | "novelty">` — a pure factory over the live review state (canvases, decomposition, dispositions, recorded run ledger + provenance, the active view, the RoutePlan gate for `planRecompute`, and `applyEffects` routing L3/presentational/recompute effects). Node-free, table-driven, unit-tested with no store.
- **Composition root (desktop, over adapters):** `createLiveCanvasOpsBackend(...)` spreads `reviewBackendCore(state)` with `projectContextBackend(reader, resolveContext)` and `noveltyBackend(reader, resolveNovelty)` into one `CanvasOpsBackend`. This is the ONLY place that touches the snapshot store, so `core` stays clean and the whole thing is still assembled from injected functions.

This mirrors exactly the pattern the two merged adapters were built for ("spread the result into a full `CanvasOpsBackend`") rather than inventing a new one.

## The resolvers (Decision #3 made concrete)

`projectContextBackend`/`noveltyBackend` take `resolve()` as a FUNCTION on purpose (re-resolve per call if the base is re-pinned mid-session). The live resolvers read the current review:

- `resolveContext(): { repoKey, baseOid }` — `repoKey = realpath(git-common-dir)` of `review.repositoryRoot` (the same derivation `project-snapshot-source.ts:73` already does with `realpathSync`), `baseOid = activePatchset(review).repository.baseOid`.
- `resolveNovelty(): { repoKey, patchset }` — the same `repoKey`, `patchset = activePatchset(review)`.

Both close over the live review object, so a re-capture that swaps `activePatchsetId` re-pins on the next call with no extra wiring — which is the seam `novelty-ledger-backend.ts` flagged for Rai in its header.

## Snapshot on review open

`context.map`/`file`/`novelty` read through `ProjectContextReader.loadFresh(repoKey, requestedBaseOid)`, which returns `absent` when no manifest exists. Today no manifest exists in the app because nothing generates one, so every live Repo-Map read would refuse. To make "the repo map served LIVE" true rather than a uniform `absent`, review creation generates the snapshot:

- On `createReviewFromPatchset`, run `ProjectSnapshotGenerator` for the review's repo at the resolved base OID, advance the `ProjectSnapshotStore` atomically only after validation (the #164 contract: byte-reproducible, freshness = fingerprint equality). Construct `ProjectContextReader(store)` and `NoveltyLedgerReader(contextReader)` once and hand them to the composition root.
- **Fail-closed:** generation is model-free and gated on size/time; on failure the readers still gate every read to a typed `absent`/`stale`/`corrupt`, and review creation does NOT fabricate a snapshot. A big-repo/slow generation must degrade to "repo map refuses, lenses still render", never to a hang or a fake — the producer path (lenses/canvases) does not depend on the snapshot.

**Open scope question (for Rai):** generate synchronously on open (simplest; small first-real repos are fine) vs. generate in the background and let early Repo-Map reads return `updating`/`absent` until it lands. Recommendation: synchronous with a size ceiling for v1; background generation is a follow-up if the ceiling bites.

## Orchestrator wiring + the gated proof

The composition root calls `attachOrchestratorSession(backend, { primer, harness: "claude", fresh: true })` and passes `mcpServer` into a live harness `query()` when an orchestrator turn is requested. v1 does NOT ship a conversational UI loop; it ships:

1. The wiring (backend + session + MCP server assembled in the composition root).
2. A gated real-turn proof (`packages/adapters/src/*.real.test.ts`, skipped unless `RENNET_LIVE_HARNESS`) that drives ONE orchestrator turn against the live backend over a real fixture review and asserts a `context.map`/`context.novelty` tool call returns snapshot-derived data with a real freshness verdict — the "built is not loaded" check (Rule 80a) for the orchestrator half. This runs on the user's subscription (non-metered), never in the normal gate.

The change feed stays unset (`changeFeed`/`canvasIds` absent) — a fresh point-in-time session, per the deferral of #31/R35.

## The render race fix (#59)

`bootstrap()` deserializes a fresh `Review` every 1500ms freshness poll; `setReview` reference-churn re-runs the canvas effect, which cancels the in-flight `review.canvases` fetch and early-returns on the same id, so on a SLOW (real) harness the enrichment never lands. Fix: key the effect on `review.id` + `activePatchsetId` via a ref, record `fetched` only on SUCCESS (a cancelled/failed fetch retries), and don't let poll churn cancel an in-flight enrichment. This needs a UI effect-test harness (jsdom/happy-dom + testing-library, ties to #53) so the fake-clock + slow-fetch retry is provable. The fast deterministic-floor path already wins the race and populates real canvases from the diff, so the app is not broken today — but "a real review renders live (model-enriched) canvases" is false on the harness path until this lands, which is why it belongs in the end-to-end wave.

## The #49 item-3 subset assertion

#49 item 3 is explicitly gated on the orchestrator being wired ("when #13 wires the real orchestrator MCP registry"). Now that it is, add the structural test: the wired `canvasOps@2` registry is a strict subset of `ORCHESTRATOR_CANVAS_OPS`, so a wired L2 disposition-writer is impossible by construction. This closes the gap between the model-level L2-sovereignty proof (already merged) and the live wired surface — a red-provable invariant, not prose.

## What each backend accessor is sourced from (honesty map)

| accessor | live source | if unrecorded |
|---|---|---|
| `canvas` / `angles` / `decomposition` / `element` / `hunk` / `searchDiff` | the `buildReviewCanvases` result + captured `Patchset` | n/a (always present for a real review) |
| `identity` / `view` | the `Review` (repo, reviewId, patchsetId, active canvas) | n/a |
| `runLedger` / `provenance` | the recorded RSP provenance + invocation ledger of the run | distinguished empty (`total: 0`) + freshness, never a fake |
| `planRecompute` | `buildRoutePlan` over the live decomposition (the #8 Brita gate) | n/a |
| `projectMap` / `fileContext` | `projectContextBackend` over the snapshot store | typed gate failure |
| `novelty` | `noveltyBackend` over the novelty reader | typed gate failure |
| `applyEffects` | routes L3 (`annotate`/`propose`) / presentational (`focus`) / `recompute` — structurally never L2 | n/a |

The one honest gap to confirm with Rai: whether `runLedger`/`provenance` are already persisted per-run for the app path, or return the distinguished-empty result in v1 (still real: "nothing recorded yet", never a fabricated ledger). Smallest-real-first would accept distinguished-empty here and light up the full ledger in a follow-up.

## Inherited deviation from Architecture Contracts §7.2

The composition root passes `cwd: review.repositoryRoot` (the harness reads the live checkout), the same documented deviation `wire-live-review-pipeline` recorded. This wave inherits it unchanged; the immutable-materialisation isolation is #30 and deferred. The deviation is named here so it is not silently widened.

## Task parallelism

Two clusters are fully independent and worktree-isolatable in parallel: the render-race/UI-harness work (`@rennet/ui`, #59/#53) and the L2-subset assertion (`@rennet/core`/protocol, #49 item 3). The backend composition, resolvers, snapshot-on-open, and orchestrator wiring are a sequential spine (core factory → resolvers/readers → desktop composition → gated proof), joined by an end-to-end acceptance task. See `tasks.md`.

## Decisions that need Rai before build

1. **Orchestrator scope for v1:** wiring + gated real-turn proof (recommended) vs. a full conversational orchestrator loop (larger, later).
2. **Snapshot generation timing:** synchronous-on-open with a size ceiling (recommended) vs. background with `updating`/`absent` early reads.
3. **`runLedger`/`provenance` source:** distinguished-empty in v1 (smallest-real-first, recommended) vs. wiring full per-run ledger persistence into this wave.
4. **Acceptance source:** local working-tree/branch as the gate path (recommended, no `gh`-auth in the gate); GitHub PR stays wired and is exercised manually.
