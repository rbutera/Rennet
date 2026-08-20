# Tasks: add-context-map-view

## 1. project.contextMap read command

- [x] 1.1 `packages/protocol`: `projectContextMapSchema` output (map, knowledge, baseRef/baseOid, typed absent) + `"project.contextMap"` command definition
- [x] 1.2 `packages/server`: `DispatchDeps.projectContextMap` + dispatch case with parse-in/parse-out
- [x] 1.3 `packages/server/create-server`: wire dep reading `snapshotStore` manifest → `ProjectContextReader.loadFresh` → `queryProjectMap` + `KnowledgeStore.loadLocal`
- [x] 1.4 Dispatch test: persisted-map fixture returns map+knowledge; absent store returns typed absent

## 2. Surface + Context Map screen

- [x] 2.1 `packages/app-ui/nav/history.ts`: add `contextMap` kind + `surfaceIdentity` case (no recents, no version bump)
- [x] 2.2 `packages/app-ui/app.tsx`: render branch, rehydrator landing case, breadcrumb label, `pushSurface` nav-out wiring
- [x] 2.3 `packages/app-ui/components/project-detail.tsx`: Context Map nav-out affordance (callback prop like `onOpenRow`)
- [x] 2.4 `packages/app-ui/components/context-map-view.tsx`: tree spine (roll-up counts, collapsed dirs, symbols on expand), neighborhood graph (selected scope + direct edges, SVG), knowledge panel (hypothesis/confirmed/rejected rendering), freshness badge — Affineur's Bench tokens + DESIGN.md ramp
- [x] 2.5 `context-map-view.dom.test.tsx`: recording fake bridge — loads `project.contextMap`, tree selection re-centers graph, knowledge filters to selection

## 3. project.contextAsk

- [x] 3.1 `packages/protocol`: `"project.contextAsk"` definition reusing the existing context-ask result shape
- [x] 3.2 `packages/server`: dispatch case + create-server dep composing `contextAskBackend` with project resolve closure (persisted tip) + existing knowledge port resolver
- [x] 3.3 UI: conversation rail in `context-map-view` — answered (with evidence), unanswered, failed states; discuss-from-statement prefill
- [x] 3.4 Tests: dispatch test with fake port (answered + no-harness failure); dom test for rail states

## 4. Knowledge disposition

- [x] 4.1 `packages/types`: `KnowledgeStatus` gains `"rejected"`; typecheck sweep of consumers
- [x] 4.2 `packages/protocol`: `"project.knowledgeDisposition"` definition (id, `confirmed | rejected`; typed not-found)
- [x] 4.3 `packages/server`: dispatch case + dep — load set, flip status by id, preserve order, `KnowledgeStore.save`
- [x] 4.4 `packages/core` delta pass: assert rejected/confirmed status survives an unchanged-region delta (test; fix carry logic if it doesn't)
- [x] 4.5 UI: confirm/reject/discuss verbs on statements, rendering persisted result; rejected excluded from ask context
- [x] 4.6 Tests: dispatch disposition round-trip; not-found; dom test for verbs

## 5. Docs + gate

- [x] 5.1 `docs/src/content/docs/using/`: Context Map page (what it shows, disposition, ask rail, how the map gets built/enriched)
- [x] 5.2 Cross-link from project workflow docs; verify no page is made wrong by the change
- [x] 5.3 Full gate `pnpm check` green; PR
