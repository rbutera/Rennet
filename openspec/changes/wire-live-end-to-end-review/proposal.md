## Why

The pieces of a Rennet review are built and merged, but the AI **orchestrator** that inhabits them never runs live, and the **Repo-Map** it would serve is wired only against test fakes. Three concrete facts on `main`:

1. **The producer path is live.** `buildReviewCanvases` (#8/#9/#10) and the three lens runners (`runFindingAngle`/`runDecisionAngle`/`runNoiseAngle`, #157/#159/#162) populate canvases and lenses from a real captured diff, and `apps/desktop/src/main/index.ts` wires them. Point Rennet at a local working tree (`GitCaptureAdapter`) or a GitHub PR (`GitHubChangesetSource`, `parseGitHubPrRef`) and the lenses render. This wave does **not** rebuild any of that.

2. **The `canvasOps@2` surface has no production backend.** The ~20-op MCP world the orchestrator inhabits — `canvas.describe/view/read`, `diff.read/search/structure`, `run.ledger/provenance`, and the Repo-Map reads `context.map`/`context.file`/`context.novelty` — reads everything through the `CanvasOpsBackend` port (`packages/core/src/canvas-ops.ts`). The **only** full implementations of that port are TEST FAKES (`canvas-ops.test.ts`). The merged Repo-Map backends (`projectContextBackend`, `noveltyBackend`) are deliberately PARTIAL: each supplies one or two accessors over an **injected** resolver, and `novelty-ledger-backend.ts` flags the missing seam in its own header — *"when the review flow grows a first-class 'current patchset' accessor on the canvasOps backend context, this resolver is the seam to wire to it."*

3. **Nothing composes or wires it.** Nothing composes canvas + diff + run + context + novelty into ONE backend over a live `RepoRecord` and a real `Patchset`, and nothing resolves the concrete `repo → repoKey → base-OID` + current patchset that backend needs. `attachOrchestratorSession(backend, config)` exists but is never called from desktop. `ProjectSnapshotGenerator` / `ProjectContextReader` / `NoveltyLedgerReader` are exported but never constructed in the app, so the Repo-Map reads return the typed `absent` gate failure rather than real data. The repo map is served to a real model **nowhere**.

So the "lenses **and** repo map served LIVE to a running orchestrator" half of the product does not run. This slice makes the thin vertical real: Rai points Rennet at a real change and the whole `canvasOps@2` surface serves a live orchestrator over real review state, end to end, in the desktop app.

## What Changes

- **Add the production `CanvasOpsBackend` composition.** Core supplies the canvas / diff / run / decomposition / identity / view / `planRecompute` / `applyEffects` accessors as pure functions over the in-memory `Review` + active `Patchset` + recorded run state; the adapters `projectContextBackend` / `noveltyBackend` slices supply `projectMap` / `fileContext` / `novelty`; a desktop composition root **spreads them into one `CanvasOpsBackend`**. Core never imports adapters — the store-backed reader slices are injected at the composition root (the dependency arrows are preserved).
- **Add the real resolvers.** `context.map`/`context.file`: `{ repoKey = realpath(git-common-dir of review.repositoryRoot), baseOid = activePatchset.repository.baseOid }`. `context.novelty`: `{ repoKey, patchset = activePatchset }`. The `repoKey = realpath(git-common-dir)` derivation already exists (`project-snapshot-source.ts`); this reuses it.
- **Generate the `ProjectSnapshot` on review open.** Run the #164 `ProjectSnapshotGenerator` + `ProjectSnapshotStore` when a review is created (fail-closed, size/budget-gated), and construct `ProjectContextReader` / `NoveltyLedgerReader` over the store, so `context.map`/`context.file`/`context.novelty` serve REAL snapshot-derived data at the resolved base OID instead of a typed `absent` refusal.
- **Wire the orchestrator session live.** Call `attachOrchestratorSession(backend, config)` in the desktop composition root, hand the resulting in-process `canvasOps@2` MCP server (`createCanvasOpsServer`) to a live harness `query()`, and add a gated real-turn proof (`RENNET_LIVE_HARNESS`) that drives one orchestrator turn against the live backend and asserts a `context.map` / `context.novelty` read returns snapshot-derived data — never a fake.
- **Close the live-canvas render race (#59).** Key the canvas-fetch effect on `review.id` + `activePatchsetId` via a ref, record `fetched` only on SUCCESS, and stop the 1500ms freshness poll's reference-churn from cancelling the in-flight enrichment fetch — so model-enriched canvases eventually render on a slow harness and regenerate re-fetches for the new patchset. Add the UI effect-test harness (jsdom/testing-library) this needs (#53).
- **Prove the wired surface is L2-free (#49 item 3).** Add a structural test asserting the WIRED `canvasOps@2` registry is a strict SUBSET of `ORCHESTRATOR_CANVAS_OPS` — the live surface can never contain an L2 disposition-writer — closing the gap between the model-level L2-sovereignty proof and the wired surface.

## Capabilities

### New Capabilities

- `live-end-to-end-review`: a production `CanvasOpsBackend` composing canvas + diff + run + Repo-Map (`context.map`/`file`/`novelty`) over a live `RepoRecord` + captured `Patchset`; the orchestrator session booted against it and served the whole `canvasOps@2` surface through a live harness; the `ProjectSnapshot` generated on review open so the repo map serves real data; the render race closed so model-enriched canvases render on a real harness; and the wired registry proven structurally L2-free.

## Impact

- Adds a core backend factory (pure, over review state) + a desktop composition root that spreads it with the adapters reader slices; adds snapshot-on-open generation + reader construction in that root; wires `attachOrchestratorSession` + a live orchestrator entrypoint; fixes the UI canvas-fetch effect and adds a UI effect-test harness; adds one structural subset test and one gated live-harness proof.
- **No new package, no new runtime dependency, no dependency-arrow change.** `core` stays node-free (the backend factory takes the reader slices as injected functions); the composition root that touches the store and generator lives in `apps/desktop` over `@rennet/adapters`. The `architecture` and `licenses` gates are untouched.
- **Inherited deviation (documented, not silent):** the composition root passes `cwd: review.repositoryRoot`, the same known deviation from Architecture Contracts §7.2 ("does not run against the live source checkout") that `wire-live-review-pipeline` recorded. The immutable-materialisation isolation (#30) is deferred and named below; this wave does not widen the deviation.

### Deferred (explicitly out of this wave)

- **Live `review.ask` send (#139):** desktop keeps `reviewAskFixturePorts()`; wiring the real orchestrator/Codex send is a follow-up.
- **Live post-commit change-feed subscription (#31/R35):** the orchestrator session boots FRESH against a point-in-time review; the live feed + engine utility-process hardening are #31. The session's `changeFeed`/`canvasIds` config stays unset in v1.
- **Full engine + event-store hardening (#31):** upcasts, replay harness, utility-process supervision, state-identity proof.
- **ContextManifest + "what was sent" panel + hostile-guidance isolation probe (#30):** v1 SERVES context; the honesty panel and the `exhaustive` isolation verdict are a follow-up.
- **The LLM knowledge layer (`.rennet/knowledge/`, #14):** v1 serves the DETERMINISTIC snapshot only; `context.knowledge` is deferred with the knowledge layer.
- **A conversational orchestrator UI loop:** this wave proves the backend + surface run live (gated real-turn proof); the reviewer-facing chat/drive UX is a later slice.
- **GitHub PR as the ACCEPTANCE path:** the PR source stays wired, but the end-to-end acceptance runs on a local working tree/branch (no `gh`-auth dependency inside the gate).
