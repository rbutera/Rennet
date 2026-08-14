# Proposal: wire-context-knowledge-layer

## Why

The context/knowledge layer is built and tested in `packages/core` and
`packages/adapters` — snapshot shards, the evidence-backed knowledge store,
project-context reads, repo composition, and the deterministic orchestrator
primer all exist — but none of it is reachable from the running desktop app.
`apps/desktop/src/main/proactive-rehydration.ts` states it plainly: the layer
"is not wired into desktop at all". There is no `context.*` namespace in
`packages/protocol/src/index.ts`, so neither the orchestrator, the reviewer,
nor the UI can ask the project's knowledge layer anything, and nobody can see
what context the fleet was actually given.

This change wires the existing layer into the app and exposes it as exactly
two surfaces, the union of issues #15 and #30 as amended by Rule Zero on
2026-08-11:

1. **`context.ask` (#15)** — one tool the orchestrator (and the reviewer,
   through the app) calls to ask a question of the project's knowledge layer
   and get back a validated **answer document**: the answer, evidence anchors
   on every claim, a confidence grade, what was consulted, and — first-class —
   `unanswered` with a reason when the layer cannot support an answer. An
   honest "the snapshot does not cover generated code" beats a fluent guess;
   the schema makes honesty cheap. That is anti-hallucination, which Rule Zero
   protects as anti-lie-in-the-UI.
2. **Context pipeline + ContextManifest (#30)** — the pipeline that assembles
   what each fleet agent is told, with deterministic golden-tested ordering,
   byte budgets with always-visible truncation, and a **"what was sent" panel**
   that shows the reviewer exactly what context the agents received, including
   the assembled prompt byte-identical to what the adapter sent. A changed
   ordering silently changes review quality; an invisible truncation is a lie
   about what the model saw.

Both issues sit at the top of the delivery order's "complete the context and
regeneration spine" list. This proposal is the wiring and the two surfaces
only — the knowledge layer itself is reused, not re-implemented.

### Rule Zero posture (binding on every artifact in this change)

Per the 2026-08-11 amendments on both issues, the following are **struck and
must not reappear** in design, tasks, or specs:

- From #15: the read-only "Does NOT have" capability-denial list, and the
  criterion that a `thorough` ask without budget headroom is "refused by the
  gate". The budget **meters and reports** — spend appears in the answer's
  cost report and the run ledger — it never refuses a question.
- From #30: the trust gate, inert-until-accepted repo guidance, re-gating on
  hash change, the "structurally cannot see guidance" validator projection,
  the hostile-guidance fixture, the escape-check, and all "hostile-proof"
  framing (the feature is titled without it).

What survives is the real feature set: the answer document with evidence and
first-class `unanswered`-with-reason (#15), and deterministic ordering, byte
budgets with visible truncation, and the "what was sent" transparency panel
(#30). The test for every reviewer of this change: does a requirement make the
product do its job better, or does it make the product harder to use safely?
Only the first belongs here.

## What Changes

Architectural correction (per the code-reality read of this branch): the
agent-facing "commands" in Rennet are **canvasOps@2 tools**, not protocol
commands — `packages/protocol` is a Zod *data-shape* layer, not a command bus.
And `ContextManifest` is **not greenfield**: the type exists
(`packages/types/src/index.ts`), it is built per review
(`packages/adapters/src/nested-project-context.ts` `manifest()`), and it
already rides out of `createLiveCanvasOpsBackend` — and is then thrown away at
the desktop boundary. So `context.ask` is a new tool; the manifest work is
surfacing an object that already exists.

- **`packages/core`** — two pieces. (a) A new canvasOps@2 tool
  `contextAskTool` in `canvas-ops.ts` (retrieval kind, `readOnly: true`,
  params `{question, scope?, budgetHint?}`) added to `CANVAS_OPS_TOOLS`, plus a
  new `ask(...)` method on the `CanvasOpsBackend` port — modelled exactly on the
  existing `contextKnowledgeTool` / `backend.knowledge(query)`. (b) A synthesis
  runner (`context-ask.ts`) that composes an answer from the existing pure
  reads (`queryKnowledge`, `queryProjectMap`, `queryFileContext`,
  `querySymbolDefinition`, `queryReferences`) plus an injected model turn
  (the `runTurn` injection pattern from `knowledge-generation.ts`), returning
  the shape the primer's PROTOCOL_CARD already advertises:
  `{answer, evidence, confidence, unanswered?}`. Model routing is pre-declared
  in `model-council.ts` (`context-ask-fetch` light / `context-ask-thorough`
  heavy). Budget is the injected `InvocationBudget`: **meter and report, never
  refuse**. Also register the tool in `orchestrator-primer.ts`'s
  `TOOL_WHEN_TO_USE` so the tool index matches the card's standing promise.
- **`packages/adapters`** — a `contextAskBackend(...)` slice (template:
  `knowledge-backend.ts`) merged into the spread in `live-review-backend.ts`
  `createLiveCanvasOpsBackend`. It binds the runner to the already-resolved
  snapshot/knowledge stores; `buildCanvasOpsTools` then attaches the tool to the
  SDK automatically, so no per-tool desktop wiring is needed. Extend the
  ContextManifest assembly here to record, per document, its order position,
  content hash, byte count, and included/truncated/dropped state (the type +
  the absent-member disclosure already exist), and persist the manifest under
  the R55 local-first project entry.
- **`packages/types` + `packages/protocol`** — carry the *already-produced*
  `ContextManifest` to the renderer. `createLiveCanvasOpsBackend` returns it and
  the desktop boundary drops it (`live-review-backend.ts` returns
  `{...(contextManifest ? {contextManifest} : {})}`). Add the manifest field to
  the review/canvases response type **and its Zod schema** (an unlisted optional
  is silently stripped across IPC — a documented failure class here), or a small
  read command to fetch it for the open review. This is the only protocol touch.
- **`apps/desktop`** — stop discarding the manifest: thread it through
  `live-review-backend.ts` / `dispatch.ts` to the renderer, and record the
  assembled-prompt digest at send time so the "assembled prompt" view is proven
  byte-identical, not reconstructed.
- **`packages/ui`** — the "what was sent" inspector
  (`context-manifest-panel.tsx`, modelled on `delta-account-panel.tsx`: a
  deterministic, model-free, gate-free informational panel): per-agent
  documents in sent order with hashes, byte counts, and truncated/dropped
  state, plus an "open the assembled prompt" byte-identical view. `context.ask`
  answers surface to the reviewer through the existing conversation stream when
  the orchestrator uses the tool — no second ask box (the review-level
  `review.ask` surface in `canvas/ask.ts` stays distinct to avoid a naming
  collision).

## What is deliberately out of scope

- **Re-implementing the knowledge layer.** `knowledge.ts`,
  `knowledge-generation.ts`, `project-snapshot.ts`, `project-context.ts`,
  `repo-composition.ts`, `orchestrator-primer.ts` and their adapter stores are
  consumed as-is. Requirements already promoted in
  `openspec/specs/repo-map-knowledge` (evidence-carrying statements, verbatim
  `context.knowledge` reads, invalidation disclosure, local-first storage and
  promotion) are not restated here.
- **The repo-map delta pass.** `build-repo-map-lifecycle` is 4/30; its
  unbuilt delta-pass half stays with #243 and is untouched by this change.
- **A warm answering sub-agent.** v1 of `context.ask` is deterministic
  composition behind the tool boundary; upgrading the machinery behind the
  unchanged contract is the follow-up the #24 experiments decide.
- **The async-ticket path** for slow asks — not until latency measurement
  says so (#24).
- **Instruction-layer settings keys** (#30's bead-84 half: `instructions.*`
  settings, config ladder) — that belongs with #28 settings v1. The struck
  trust-gate machinery is not deferred; it is deleted.
- **The context-isolation probe** (spike 6) — a separate evidence task; the
  manifest ships `exhaustive: false` with `unmanagedSources` honestly listed
  until a probe proves better.

## Capabilities

### New

- `context-ask`: one schema-constrained tool over the project knowledge
  layer, answering with evidence or honestly not answering with a reason;
  budget metered and reported, never refused.
- `context-manifest`: deterministic assembly of what each fleet agent is
  told, recorded per patchset, inspectable down to the exact bytes sent.

### Modified

- None. Existing promoted specs (`repo-map-knowledge`, `repo-map-storage`,
  `orchestrator-session`, `canvasops-mcp-surface`) are consumed, not amended;
  the `canvasOps@2` registry gains one registered tool, which its spec already
  anticipates as a seam.

## Impact

- **Affected packages**: `core` (the `contextAskTool` + `CanvasOpsBackend.ask`
  + the `context-ask.ts` synthesis runner + the primer tool-index entry),
  `adapters` (the `contextAskBackend` slice + the richer manifest assembly +
  persistence), `types`/`protocol` (one field: carry the existing
  `ContextManifest` across IPC, declared in Zod), `apps/desktop` (thread the
  manifest through instead of dropping it + capture the sent digest), `ui` (the
  "what was sent" inspector). No new protocol *command* namespace — `context.ask`
  is a canvasOps@2 tool.
- **Affected docs**: `docs` context-assembly page's "`context.ask` seam"
  section becomes live-surface truth once this ships (doc update is a task).
- **Migration**: none — all additive. No stored format changes; manifests are
  a new artifact under the existing R55 project entry.
- **Gate**: `NX_DAEMON=false pnpm check` (format, architecture, licenses,
  lint, typecheck, test, build), with red-proof-first tests per task.
