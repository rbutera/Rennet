## 1. Uniform envelope + backend port (core)

- [ ] 1.1 `OpsEnvelope<T>` (`{data, evidence?, freshness, total?, cursor?, truncated?}`) and `OpsFreshness` (`current | updating | stale | failed`)
- [ ] 1.2 `OpsError` + `ToolOutcome` (ok envelope + effects, or structured error) — errors are for malformed calls only; "nothing found" and "over budget" are distinguished ok values
- [ ] 1.3 `CanvasOpsEffect` union — annotate (L3) | propose (L3) | focus (presentational) | recompute (visible, budget-gated). No L2 variant by construction
- [ ] 1.4 `CanvasOpsBackend` port: identity, freshness, canvas resolution, view, element/thread/hunk/diff-search/decomposition/run-ledger/provenance reads, recompute budget plan, and `applyEffects`

## 2. Tool surface (core)

- [ ] 2.1 Neutral `ToolParam` spec + `CanvasOpsTool` descriptor (name, description-with-trigger, kind, readOnly, alwaysLoad, params, pure handler)
- [ ] 2.2 Pagination-with-totality helper (offset cursor, honest `total`, `cursor: null` at completion, no silent cap)
- [ ] 2.3 The six interaction ops: `canvas.describe` (counts | cohorts | elements, paginated), `canvas.view`, `canvas.focus`, `canvas.annotate`, `canvas.propose` (bulk), `canvas.recompute` (budget-gated via RoutePlan)
- [ ] 2.4 The seven retrieval ops (all read-only): `canvas.read`, `canvas.thread`, `diff.read`, `diff.search`, `diff.structure`, `run.ledger`, `run.provenance`
- [ ] 2.5 `CANVAS_OPS_TOOLS` (the full ordered list) + `CANVAS_OPS_VERSION` = `canvasOps@2`; hot trio marked `alwaysLoad`
- [ ] 2.6 Re-export from `packages/core/src/index.ts`

## 3. SDK MCP server (adapters)

- [ ] 3.1 `buildCanvasOpsTools(backend)`: compile each descriptor's param spec → Zod shape, wrap the pure handler into an SDK `CallToolResult` handler (envelope as text + structuredContent; `isError` on a structured error; effects applied through the backend), set `readOnlyHint` + `alwaysLoad`
- [ ] 3.2 `createCanvasOpsServer(backend)`: `createSdkMcpServer` with the compiled tools, `name: rennet-canvas-ops`, `version: 2.0.0`, and the protocol-card semantics as `instructions`
- [ ] 3.3 Re-export from `packages/adapters/src/index.ts`

## 4. Verification

- [ ] 4.1 Core tests: describe(counts→cohorts→elements) round-trip; pagination totality (cursor walks to completion, `total` correct, no silent cap); freshness rides the reply (stale after a seeded advance); bulk propose is L3 and only user adjudication yields L2 (event trace); structural — the surface contains no user-only/engine-only op and no handler produces an L2 write; "nothing found" distinguished from a failed call
- [ ] 4.2 Adapters tests: the SDK server registers the expected tool set with correct `readOnlyHint`/`alwaysLoad`; the SDK-shaped handlers round-trip describe(counts)→describe(cohorts)→read(one element) without spawning a model
- [ ] 4.3 `pnpm check` green across all projects (zero errors + `Successfully ran target`)
