# Design

## The pipeline (`buildReviewCanvases`, `@rennet/core`)

One async, pure orchestration over the already-shipped pieces:

1. `decompose(patchset, decomposeOptions)` → `Decomposition` (#7 floor: substrate + deterministic reading order, zero model, offline).
2. `buildRoutePlan(decomposition, routePlanOptions)` → the **Brita gate**. Computed *before any model call*. If it refuses (invocation count over the ceiling), the model phase is skipped entirely.
3. If a `runDecompositionTurn` is provided **and** the route plan did not refuse: `runDecompositionAngle` produces an admitted `decomposition.proposal` document (or its own deterministic fallback). When a `runOrderingTurn` is also provided, `runOrderingPass` produces the comprehension order, and the live order (`resolveLiveOrder`) is applied to the proposal that feeds placement. Otherwise `admittedDocs` is empty and the deterministic floor stands.
4. `buildCanvas` for each of `CANVAS_ANGLES` with `{ admittedDocs, decomposition, dispositions, canvasEvents }`.

**Why the Brita gate lives here and refuses to the floor, not an error:** the ⭐ requirement is that the `<5`-invocation ceiling actually gates the first real metered-adjacent calls. A refusal is not a failure of the review — it is "this change is too big to decompose agentically within budget", and the honest response is the deterministic floor (real substrate + deterministic sequence from the same diff), never a spinner and never an unbudgeted spend. Both arms are tested: refuse → the injected `runTurn` is never called; pass → it is.

**Why `admittedDocs = []` still populates canvases:** `projectSequence` already carries a deterministic floor branch (the decomposition's own chunks in reading order), and `projectSubstrate` is a pure function of the decomposition. So even with no harness, no model, or a budget refusal, the canvases are real and derived from the captured diff — the agentic proposal only enriches them.

**Ordering → canvas:** the sequence canvas reads the proposal body's `readingOrder`. To make the comprehension pass visible, the pipeline places a proposal whose `readingOrder` is the ordering pass's live order over the same chunk set (the ordering validator guarantees the order covers exactly that set). The placed document's identity (`docId`) is the admitted proposal's; only the order it presents is refined. When ordering is absent or falls back, the #8 baseline order stands.

## The injected turn (`createHarnessRunTurn`, `@rennet/core`)

`runDecompositionAngle`/`runOrderingPass` already take an injected `runTurn(prompt, attempt)`; this builds the real one over the `HarnessPort` **interface** only (no `@rennet/adapters` import, so `core` never imports `adapters`). It creates a read-only session (`readOnly: true`) with `outputSchema = bodyJsonSchema(docType)`, sends one turn,

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. Drop `readOnly: true`; the session runs with the user's own harness capabilities. Everything else about this adapter (output schema, one turn, outcome mapping, always-close) is unchanged. and iterates `session.events` to the `session.ended` frame: a `completed` outcome with `structuredOutput` becomes `{ status: "emitted", body }`; anything else (no structured output, failed, cancelled, an `error` frame) becomes `{ status: "failed" }` so the angle's own fallback takes over. The session is always closed.

## The router (`createDispatch`, `@rennet/core`)

The existing desktop `dispatch()` switch is moved verbatim into an electron-free factory that takes injected effects (`chooseRepository`, `startWatching`, `isRepositoryDirty`/`setRepositoryDirty`, `buildCanvases`) and a `ReviewService`. This makes routing unit-testable without electron and thins the electron file to a composition root. New cases:

- `review.canvases` → the injected harness-backed `buildCanvases(review)`.
- `canvas.disposition` → `ReviewService.setDisposition` (the sovereign L2 write; the protocol input already uses `path`/`disposition`, matching the service, so #49 item 2 needs no rename).
- `canvas.adjudicateProposal` → returns the current review (the accept→L2 write is issued by the renderer as a `canvas.disposition`; this is the L3 resolution ack).
- `canvas.setCohortExpansion` / `canvas.select` / `canvas.pinAnnotation` / `canvas.clearAnnotation` → `{ ok: true }`. These are L3/view ops with no persistence layer yet (the canvas-op store is #13); acknowledging is honest for this slice and the UI already tolerates it (`.catch(() => undefined)`).

## UI (`RennetApp`, `@rennet/ui`)

`demoCanvases()` stays the instant default so the demo is always clickable. When a real review exists and the Canvases view is open, `RennetApp` invokes `review.canvases`; on success it renders the real five-angle set, on failure (harness unavailable, pipeline error) it keeps the fixtures. The optimistic `applyWrites`/`resolveProposal` logic operates on whichever set is active; a real `canvas.disposition` round-trips through the bridge to the engine. A full re-query on the change feed is #13/#31 and out of scope; the invalidation seam is already present in the workspace.

## Known deviation from Architecture Contracts §7 (documented, not silent)

Architecture Contracts §7 states: "A harness receives only an immutable review
materialisation and explicitly assembled context by default. It does not run
against the live source checkout." This slice's composition root
(`apps/desktop/src/main/index.ts`) passes `cwd: review.repositoryRoot` — the
**live mutable checkout** — to the read-only harness session, so the model's
`Read`/`Grep`/`Glob` can see material outside the captured patchset. This is a
deliberate, temporary deviation, recorded here rather than left as silent drift:

- The immutable-materialisation layer does not exist yet, and the
  "Claude CLI isolation" evidence gate is openly **Blocked** in
  `docs/Rennet Evidence Gate Status.md` — nothing that was proven has regressed.
- The session is `readOnly: true`, so the deviation is an *information-boundary*
  concern (the harness can read the wider tree), not a data-corruption one.
- The real fix — materialise the active patchset into an app-owned cache and
  point `cwd` there — is a follow-up (its own slice/bead), not this wiring slice.

Merging this slice does not close the §7 isolation gate; it lights up the first
real-harness path, and the deviation is called out so the next reader does not
mistake `cwd: review.repositoryRoot` for a satisfied contract.

## Deferred

- L3 canvas-op persistence (adjudicate/pin/clear/cohort/select durability) — #13.
- The canvasOps@2 registry-subset structural assertion (#49 item 3) — needs #13's real MCP registry.
- Token-usage reporting on the harness outcome (the SDK outcome does not surface tokens in slice 1) — the pipeline records `ZERO_TOKENS`.
- Change-feed-driven re-query of live canvases after a write — #31.
- Materialise the active patchset to an app-owned cache and run the harness with
  `cwd` pointed there, closing the §7 deviation above (isolation evidence gate).
