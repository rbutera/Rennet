## 1. Core: the pure review backend factory (TDD) — spine

- [ ] 1.1 `packages/core/src/review-backend.ts`: `reviewBackendCore(state)` returning every `CanvasOpsBackend` accessor EXCEPT `projectMap`/`fileContext`/`novelty` — pure over the live `Review` + active `Patchset` + `buildReviewCanvases` result + recorded run state; `planRecompute` = `buildRoutePlan` (#8 Brita gate); `applyEffects` routes L3/presentational/recompute (structurally never L2)
- [ ] 1.2 Tests (no store): each accessor returns diff-derived data for a real fixture review; `runLedger`/`provenance` return distinguished-empty (`total: 0` + freshness) when unrecorded, NEVER a fake (positive control: a fabricated ledger entry would be caught)
- [ ] 1.3 Export `reviewBackendCore` + its state type from `packages/core/src/index.ts`

## 2. Adapters + resolvers: snapshot-on-open + the live resolvers (TDD) — spine

- [ ] 2.1 `resolveContext()` / `resolveNovelty()` builders over a live `Review`: `repoKey = realpath(git-common-dir)` of `repositoryRoot` (reuse the `project-snapshot-source` derivation), `baseOid`/`patchset` from `activePatchset(review)`
- [ ] 2.2 Snapshot-on-open: on `createReviewFromPatchset`, run `ProjectSnapshotGenerator` + advance `ProjectSnapshotStore` atomically-after-validation at the resolved base OID; construct `ProjectContextReader` + `NoveltyLedgerReader`. Fail-closed + size/time-gated: on failure the readers gate to typed `absent`/`stale`/`corrupt` and creation does NOT fake a snapshot
- [ ] 2.3 Tests: snapshot present → `context.map`/`file`/`novelty` serve real data at the resolved OID; snapshot absent/stale → typed gate failure (both arms); a snapshot at a wrong OID is refused as `stale`, never served

## 3. Composition root: spread into one live backend + wire the orchestrator (TDD) — spine

- [ ] 3.1 `createLiveCanvasOpsBackend(...)` in `apps/desktop/src/main` (over `@rennet/adapters`): spread `reviewBackendCore(state)` with `projectContextBackend(reader, resolveContext)` + `noveltyBackend(reader, resolveNovelty)` into one `CanvasOpsBackend`
- [ ] 3.2 Boot the orchestrator: `attachOrchestratorSession(backend, { primer, harness: "claude", fresh: true })`; hold the `mcpServer` for a live `query()`; `changeFeed`/`canvasIds` unset (fresh point-in-time session)
- [ ] 3.3 Tests: the composed backend satisfies the full `CanvasOpsBackend` over a live fixture review (every accessor real or honestly-empty); booting the session spawns NO model (assert no harness process until a live query runs)

## 4. UI: close the live-canvas render race (#59) + effect-test harness (#53) — PARALLEL

- [ ] 4.1 Add the UI effect-test harness (jsdom/happy-dom + testing-library) with a fake clock and a controllable slow fetch (#53)
- [ ] 4.2 Key the canvas effect on `review.id` + `activePatchsetId` via a ref; record `fetched` only on SUCCESS; stop freshness-poll reference-churn cancelling an in-flight enrichment fetch
- [ ] 4.3 Tests: slow harness → model-enriched canvases eventually render after a poll-induced cancel (fake clock + slow fetch); regenerate → re-fetch for the new patchset, no pinning to the old

## 5. Structural: the wired canvasOps@2 registry is L2-free (#49 item 3) — PARALLEL

- [ ] 5.1 Test asserting the WIRED registry is a strict subset of `ORCHESTRATOR_CANVAS_OPS`; adding an L2 disposition-writer to the wired set makes it fail (red-provable)

## 6. Gated live proof + end-to-end acceptance — join

- [ ] 6.1 `packages/adapters/src/orchestrator-live.real.test.ts` gated by `RENNET_LIVE_HARNESS`: build the production backend over a real fixture review, drive ONE orchestrator turn via a live `query()`, assert a `context.map`/`context.novelty` tool call returns snapshot-derived data with a real freshness verdict + evidence (never a fixture); skipped in the normal gate
- [ ] 6.2 End-to-end acceptance (local working-tree/branch source): create a review → snapshot generated → lenses/canvases render (producer path) AND the Repo-Map serves real data through the live backend; documented as the v1 acceptance path (GitHub PR source stays wired, exercised manually)

## 7. Gate

- [ ] 7.1 `pnpm check` green across all projects (format, architecture, licenses, lint, typecheck, test, build): zero errors + `Successfully ran target(s)`; a clean check includes a positive control capable of failing
