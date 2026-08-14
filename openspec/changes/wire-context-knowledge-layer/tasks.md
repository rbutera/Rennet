# Tasks — wire-context-knowledge-layer (#15 + #30)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof each behaviour first. REUSE the existing layer — do NOT re-implement `knowledge.ts`, `project-context.ts`, `project-snapshot.ts`, `repo-composition.ts`, `nested-project-context.ts`, or the ContextManifest builder. `context.ask` is a canvasOps@2 TOOL, not a protocol command. Any field crossing desktop IPC MUST be declared in its `packages/protocol` Zod schema (an unlisted optional is silently stripped). No consent/trust/access gate anywhere; budget meters and reports, never refuses (Rule Zero).

## 1. Study the substrate
- [ ] 1.1 Read `packages/core/src/canvas-ops.ts` (`CanvasOpsBackend`, `CanvasOpsTool`, `contextKnowledgeTool`, `CANVAS_OPS_TOOLS`, the `ok`/`unavailable`/`optString`/`enumArg` helpers), `knowledge-generation.ts` (the `runTurn`+`budget` injection pattern), `project-context.ts` / `knowledge.ts` (the pure reads + `SnapshotGateFailure`), `orchestrator-primer.ts` (PROTOCOL_CARD's `context.ask` promise + `TOOL_WHEN_TO_USE`), `model-council.ts` (`context-ask-fetch`/`context-ask-thorough`). Read `packages/adapters/src/{knowledge-backend.ts,live-review-backend.ts,nested-project-context.ts}` (the manifest builder + the dropped-at-boundary return) and `packages/types/src/index.ts` `ContextManifest`. Confirm the manifest's current fields and where it is discarded.

## 2. Slice A — the `context.ask` synthesis runner (core)
- [ ] 2.1 `packages/core/src/context-ask.ts`: a pure runner `runContextAsk(input)` with an injected `runTurn` + optional `budget: InvocationBudget`, composing an answer from `queryKnowledge` + the `project-context` reads over a materialized snapshot. Returns `ContextAnswer` = `{answer, evidence[], confidence, consulted[], cost, unanswered?}` (the PROTOCOL_CARD shape). Enforce: evidence-or-fail (claims with empty evidence → failed ask, never a clean answer); `unanswered`-with-reason is a schema-valid SUCCESS; budget meters into `cost` and NEVER refuses (a no-headroom `thorough` still runs + reports overage). Resolve the model via `context-ask-fetch`/`context-ask-thorough` by `budgetHint`.
- [ ] 2.2 Tests: evidence-backed answer validates; evidence-free answer rejected as failed; `unanswered` success; metered `cost`; no-headroom `thorough` still answers (assert no refusal path).

## 3. Slice A — the canvasOps tool + backend + primer (core + adapters)
- [ ] 3.1 In `canvas-ops.ts`: add `ask(query): Promise<...>` to `CanvasOpsBackend`; add `contextAskTool` (retrieval, `readOnly:true`, params `{question, scope?, budgetHint?}`) that calls `backend.ask`, returning `ok(answerDoc, meta)` / `ok(unanswered(...), meta)`; register in `CANVAS_OPS_TOOLS`.
- [ ] 3.2 In `orchestrator-primer.ts`: add the `context.ask` entry to `TOOL_WHEN_TO_USE` so the tool index matches the standing PROTOCOL_CARD promise.
- [ ] 3.3 `packages/adapters/src/context-ask-backend.ts`: a `contextAskBackend(reader, knowledgeStore, resolve)` slice (template: `knowledge-backend.ts`) that wires `runContextAsk` to the resolved snapshot/knowledge stores; merge it into the backend spread in `live-review-backend.ts` `createLiveCanvasOpsBackend`. Confirm `buildCanvasOpsTools` attaches the tool to the SDK with no extra desktop wiring.
- [ ] 3.4 Tests: the tool is in `CANVAS_OPS_TOOLS` + `TOOL_WHEN_TO_USE`; a backend call round-trips through the tool `handle`; red-proof the registration (removing it reddens).

## 4. Slice B — extend + deterministically assemble the ContextManifest (adapters/core)
- [ ] 4.1 Extend the ContextManifest record (type in `packages/types` + the builder in `nested-project-context.ts`) to carry, per document: order position, content hash, source path, byte count, `included|truncated|dropped`; plus total assembled bytes, `exhaustive` (false until a probe proves otherwise) + `unmanagedSources`, and the assembled-prompt digest. PRESERVE the existing absent-member disclosure (do not redefine `openspec/specs/nested-repo-maps`).
- [ ] 4.2 Make the assembly deterministic + byte-budgeted: identical inputs → byte-identical assembled context (golden-tested); truncate only at section boundaries; record every truncated/dropped section with its byte count. No silent drop.
- [ ] 4.3 Tests: golden ordering holds (an ordering change reddens the golden); over-budget assembly cuts at boundaries and the manifest lists every cut with byte counts.

## 5. Slice B — carry the manifest to the renderer + capture the send digest (types/protocol/desktop)
- [ ] 5.1 Add the `ContextManifest` to the review/canvases response TYPE (`packages/types`) AND its Zod schema (`packages/protocol`) — or a small read command to fetch it for the open review. Round-trip parse test: no field stripped across IPC.
- [ ] 5.2 In `apps/desktop/src/main/{live-review-backend.ts,dispatch.ts}`: stop discarding `contextManifest`; thread it through to the renderer. Capture the assembled-prompt digest at adapter send time. Persist the manifest under the R55 local-first project entry.
- [ ] 5.3 Tests: manifest reaches the renderer intact through the real dispatch path; it persists + reloads across a fresh session; the "assembled prompt" digest equals the recorded send digest.

## 6. Slice B — the "what was sent" inspector (ui)
- [ ] 6.1 `packages/ui/src/components/context-manifest-panel.tsx` (modelled on `delta-account-panel.tsx`: deterministic, model-free, gate-free): per-agent documents in sent order with hashes, byte counts, truncated/dropped state; plus an "open the assembled prompt" byte-identical view. Wire it into the review surface.
- [ ] 6.2 DOM tests: the panel renders sent-order documents with truncation marked; nothing it shows is absent from the manifest; the assembled-prompt view's digest matches; no gate/consent affordance anywhere.

## 7. Prove it
- [ ] 7.1 Each behaviour red-proofed (revert → its test reddens). No gate/consent/trust anywhere (grep + assert). Keep every existing canvas-ops/knowledge/primer test green.
- [ ] 7.2 Full gate green; state which packages changed + the tip sha + gate total. Confirm `context.ask` is a canvasOps tool (no new protocol command namespace) and the only protocol touch is the manifest-carry field.
