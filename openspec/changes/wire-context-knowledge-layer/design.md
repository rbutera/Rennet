# Design — wire-context-knowledge-layer (#15 + #30)

Two surfaces over the already-built context/knowledge layer. Grounded in the
code-reality read of this branch; two premises corrected from the issue text:
`context.ask` is a **canvasOps@2 tool** (not a protocol command), and
`ContextManifest` **already exists and is produced per review** (the gap is
surfacing + persistence, not a new pipeline).

## What already exists (reuse, do not rebuild)

- **Pure reads** (`packages/core`): `queryKnowledge` (`knowledge.ts`),
  `queryProjectMap` / `queryFileContext` / `queryFileOverview` /
  `querySymbolDefinition` / `queryReferences` (`project-context.ts`),
  `materializeSnapshot` → `LoadedSnapshot`, the fail-closed
  `SnapshotGateFailure` taxonomy, `KnowledgeView`/`KnowledgeResult`.
- **Model-turn injection pattern** (`knowledge-generation.ts`):
  `runKnowledgeEnrichment` takes `runTurn(prompt, attempt)` + optional
  `budget: InvocationBudget`. `context.ask`'s runner copies this.
- **canvasOps tooling** (`canvas-ops.ts`): `interface CanvasOpsBackend` (the
  port), `interface CanvasOpsTool`, the `contextKnowledgeTool` (retrieval,
  `readOnly:true`) as an exact template, `CANVAS_OPS_TOOLS` registry, helpers
  `ok`/`fail`/`unavailable`/`paginate`/`optString`/`enumArg`. Attach path:
  `canvas-ops-server.ts` `buildCanvasOpsTools` → SDK `tool()` automatically.
- **Adapter binding pattern** (`knowledge-backend.ts`): a slice
  `{ knowledge(query) }` merged into the backend spread in
  `live-review-backend.ts` `createLiveCanvasOpsBackend`.
- **Primer** (`orchestrator-primer.ts`): PROTOCOL_CARD **already** advertises
  `context.ask` and its `{answer, evidence, confidence, unanswered?}` shape;
  `TOOL_WHEN_TO_USE` has no entry yet (the promise outruns the tool).
- **Model routing** (`model-council.ts`): `context-ask-fetch` (light) and
  `context-ask-thorough` (heavy) seats are pre-declared.
- **ContextManifest** (`types/index.ts`): the type exists; built by
  `nested-project-context.ts` `manifest()`; returned from
  `createLiveCanvasOpsBackend` as `contextManifest` and **dropped** at the
  desktop boundary (`live-review-backend.ts` returns
  `{...(contextManifest ? {contextManifest} : {})}`). The absent-member
  disclosure contract is promoted in `openspec/specs/nested-repo-maps`.

## Slice A — `context.ask` (issue #15)

**The tool.** Add `contextAskTool` to `canvas-ops.ts`: `kind: "retrieval"`,
`readOnly: true`, params `{question: string, scope?, budgetHint?: "quick" |
"thorough"}`, `handle(args, backend)` calls `backend.ask(query)` and returns
`ok(answerDoc, meta)` or `ok(unanswered(reason, consulted), meta)`. Register it
in `CANVAS_OPS_TOOLS`; `TOOLS_BY_NAME`/`buildCanvasOpsTools` follow
automatically.

**The port method.** Add `ask(query): Promise<ContextAskResult>` to
`CanvasOpsBackend` next to `knowledge(query)`.

**The synthesis runner** (`context-ask.ts`, pure, model-turn injected):
composes an answer from the existing pure reads (`queryKnowledge` +
`queryProjectMap`/`queryFileContext`/`querySymbolDefinition`/`queryReferences`
over the materialized snapshot) and one injected `runTurn`. It returns the
PROTOCOL_CARD shape:

```
type ContextAnswer = {
  answer: string;
  evidence: EvidenceAnchor[];        // file:line | shard ref | knowledge-statement id
  confidence: "high" | "medium" | "low";
  consulted: string[];               // what was read
  cost: { turns, model, ... };       // metered spend, always present
  unanswered?: { reason: string };   // first-class success, not an error
};
```

Rules baked into the runner:
- **Evidence-or-nothing**: an answer with claims and an empty `evidence` array
  is invalid → reported as a failed ask, never a clean answer (anti-hallucination).
- **`unanswered` is a success**: when the snapshot/knowledge demonstrably can't
  answer, return `unanswered` with a reason naming what was consulted. Not an
  error, not a guess.
- **Budget meters, never refuses**: use the injected `InvocationBudget` to
  count + report spend into `cost`; a `thorough` ask with no headroom still runs
  and reports the overage. No refusal path (Rule Zero).
- **Model routing**: resolve through `context-ask-fetch`/`context-ask-thorough`
  by `budgetHint`, carrying the resolution trace.

**Adapter + primer.** `contextAskBackend(reader, knowledgeStore, resolve)` slice
(template `knowledge-backend.ts`) merged into the `createLiveCanvasOpsBackend`
spread. Add the `context.ask` entry to `TOOL_WHEN_TO_USE` so the tool index
matches the card.

**Reviewer surface.** `context.ask` is primarily the orchestrator's tool; its
answers reach the reviewer through the existing conversation stream when the
orchestrator uses it. Do NOT add a second reviewer ask box — the review-level
`review.ask` surface (`canvas/ask.ts`) stays distinct to avoid a naming
collision. A dedicated reviewer entry point is a deferred follow-up.

## Slice B — ContextManifest surfacing + the "what was sent" panel (issue #30)

**Extend the manifest to record the assembly.** The type + builder exist; add
per-document records — order position, content hash, source path, byte count,
`included | truncated | dropped` — plus total assembled bytes, `exhaustive`
(false until an isolation probe proves otherwise) with `unmanagedSources`, and
the assembled-prompt digest. Preserve the existing absent-member disclosure.

**Deterministic + byte-budgeted assembly.** The assembly that feeds the manifest
SHALL be deterministic (golden-tested: identical inputs → byte-identical
assembled context) and respect a per-assembly byte budget, truncating only at
section boundaries and recording every cut in the manifest. No silent drop.

**Carry it across IPC.** `createLiveCanvasOpsBackend` already returns
`contextManifest`; stop dropping it at the desktop boundary. Add the manifest to
the review/canvases response **type in `packages/types` AND its Zod schema in
`packages/protocol`** (an unlisted optional is silently stripped — the
IPC-field-fidelity failure class), or a small read command that fetches the
manifest for the open review. Persist the manifest under the R55 local-first
project entry so it reloads across restart.

**Capture the sent digest.** Record the assembled-prompt digest at adapter
send time so the "assembled prompt" view is provably byte-identical, not a
reconstruction (assert digest equality in a test on the capture path).

**The panel** (`packages/ui/src/components/context-manifest-panel.tsx`, modelled
on `delta-account-panel.tsx` — deterministic, model-free, gate-free,
informational): per-agent documents in sent order with hashes, byte counts, and
truncated/dropped state; plus an "open the assembled prompt" byte-identical
view. It gates nothing; honesty is provided by showing the truth, not by
restricting what may be sent.

## Rule Zero (binding)

No consent/trust/access gate, no acceptance ceremony, no read-only posture, no
capability denial anywhere in this capability. Repo guidance (CLAUDE.md,
AGENTS.md, `.rennet/`) feeds the pipeline directly, labelled by source in the
manifest — no accept/trust step. The budget meters and reports; it never
refuses. `unanswered`-with-reason is anti-lie-in-the-UI, which Rule Zero
protects. Every struck item from the #15/#30 amendments (the "Does NOT have"
denial list, budget refusal, the trust gate, inert-until-accepted guidance,
re-gating on hash, the structural "cannot see guidance" validator, the hostile
fixture/escape-check, "hostile-proof" framing) is deleted, not deferred.

## Out of scope (stated, not silently dropped)

- Re-implementing the knowledge layer (consumed as-is; `repo-map-knowledge`
  requirements not restated).
- The repo-map delta pass (`build-repo-map-lifecycle` 4/30 → stays #243).
- A warm answering sub-agent behind `context.ask` (v1 is deterministic
  composition; upgrading the machinery behind the unchanged tool contract is a
  follow-up).
- A dedicated reviewer ask entry point distinct from `review.ask`.
- The context-isolation probe that would let `exhaustive` be `true`; until then
  the manifest ships `exhaustive: false` honestly.

## Tests (red-proof each)

- **A:** the tool is registered and appears in `TOOL_WHEN_TO_USE`; an
  evidence-backed answer validates; an evidence-free answer is rejected as
  failed; `unanswered` is a schema-valid success; spend is metered into `cost`
  and a no-headroom `thorough` ask still answers (no refusal).
- **B:** golden ordering holds (identical inputs → identical bytes; an ordering
  change reddens the golden test); over-budget assembly cuts at section
  boundaries and records every truncated/dropped section; the manifest crosses
  IPC intact (round-trip parse — no stripped field); the manifest persists and
  reloads; the assembled-prompt digest matches the recorded send digest; the
  panel renders sent-order documents with truncation marked and nothing it shows
  is absent from the manifest.
- Full `NX_DAEMON=false pnpm check` green.
