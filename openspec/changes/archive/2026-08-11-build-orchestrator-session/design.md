## Context

Issue #13 builds the orchestrator **session** on top of #12's `canvasOps@2` surface and #10's `CanvasChangeFeed`. The design is fixed by two authorities: [[Rennet Orchestrator Context Access]] §1/§4 (the map-not-container primer and the ask protocol) and [[Rennet Canvas Paradigm]] §3.2 (the context-update stream), with R35 (Contracts §2.4 / [[Rennet Reactive Streams (RxJS)]]) governing how the stream is built. This slice is pure logic in `core` plus a thin attachment in `adapters`; it adds no dependency and changes no dependency arrow.

## Goals / Non-Goals

- **Goals:** a deterministic ≤ 4 KB primer that is a map (counts + orientation + a versioned protocol card + a tool index) whose digest is recorded in provenance; a context-update stream that pushes structured user acts, consumes the change feed in seq order, batches deixis under an injected clock, injects view context at request time, and is byte-for-byte inspectable; a fresh-by-default session shell that attaches the live `canvasOps@2` surface; the adapter that constructs the MCP server alongside the session.
- **Non-Goals:** the `context.*` retrieval bucket and the knowledge agent behind `context.ask` (a later slice); the async ask-ticket path; the E1–E5 experiments; persisting L3 canvas-op events (#54); any change to #12's surface or #10's feed.

## Decisions

### The primer is a pure function of already-derived state
`assemblePrimer(inputs: PrimerInputs): PrimerManifest` takes plain data (identity, freshness rows, count summaries, tool index, run-ledger headline) — not a live backend — so "same state → same bytes" is trivially testable with a fixture and no canvas mock. The host computes `PrimerInputs` from canvases; a convenience `summarizeCanvasCounts(canvas, residue)` derives B3 from a `Canvas`. Assembly sorts by stable keys (freshness by repoId; canvas state by `CANVAS_ANGLES` index; the tool index preserves the registry's own order) so determinism does not depend on input order. The digest is the node-free `sha256Hex(text)` from `@rennet/protocol` — `core`'s existing `payloadDigest` uses `node:crypto`, but the primer digest must stay portable and is over a plain string, so `sha256Hex` is the right primitive.

### The protocol card is a versioned constant, the tool index is derived from the live surface
The card (B4) is teaching that outlives any one build, so it is a fixed `PROTOCOL_CARD` string with `PROTOCOL_CARD_VERSION` — "matches the versioned template" is a byte-equality assertion. The tool index (B5) is derived from `CANVAS_OPS_TOOLS` at boot, so it is honest about what is actually attached and callable in this build; each tool gets a terse hand-authored when-to-use one-liner (fallback: the first sentence of its description) to stay in budget and in sync. This deliberately separates the stable teaching layer from the live menu: the card teaches the canvasOps@2 contract shape; the index lists what is wired now.

### The stream is a merge over one seq space, not Rx (R35)
`ContextUpdateStream` has two inputs: direct user-act pushes (structured `{selected}/{disposed}/{proposal-adjudicated}/{viewing}`) and a subscription to `CanvasChangeFeed` (each notification → an ordered `{changed}` invalidation-hint event carrying its `seqRange`). Both carry a store `seq`; delivery is in seq order and consumers coalesce, never reorder. This is the ratified discipline without the library: explicit subscription lifecycle, seq-ordered single-source delivery, bounded buffers, one named feed. The `{viewing}` deixis batcher is the one time-based coalescer — a hand-rolled bounded buffer under an injected `now()` clock: `pushViewing` coalesces by `canvasId` (later replaces earlier, `covers` widened to span every coalesced seq), `flushDue(now)` delivers each canvas whose window elapsed as ONE event that **states the seq range it covers** (never silent). Tests drive the clock explicitly, so no real timers.

### The open-assembled-prompt panel is the shared, inspectable state
Every delivered event is appended to a `PromptContextLog` (append-only, ordered). `serialize()` renders the primer text followed by the ordered events as the byte-for-byte inspectable panel (DSL §6.3 doctrine). "Next-turn context" is a watermark over the log: `nextTurnContext()` returns events since the last `startTurn()`. There are **no dwell/pace metrics** anywhere — a `{viewing}` event names the canvas/cohort, never a duration.

### Request-time injection resolves deixis (Q5)
`buildRequest(question, view)` snapshots the current `ViewState` (open canvas, active lens/angle, expanded cohort, selection) INTO the request at ask time, so "does this alter the auth path?" resolves without the user restating what "this" is. This is separate from the pushed `{viewing}` stream: the stream keeps the orchestrator's model current as the user navigates; the request injection binds the specific ask to the specific view.

### Fresh by default (OQ9)
`bootOrchestratorSession` defaults to a fresh session per review, one user-picked harness slot. The session holds the primer manifest (digest in `provenance`), the attached tool index, the stream, and the panel. The adapter `attachOrchestratorSession` additionally constructs the in-process MCP server via #12's `createCanvasOpsServer(backend)` (lazy SDK load, injectable for tests) so the same descriptors the tool index names are the ones the model can actually call.

## Risks / Trade-offs

- **Budget pressure on B5:** 13 tools × a one-liner could crowd 4 KB alongside the ~1.5 KB card. Mitigated by terse one-liners and a byte-budget test that fails red if the full-review primer exceeds 4 KB.
- **The tool index and the card can drift** (index derived, card fixed). Accepted: the card teaches the contract, the index lists the live surface; a divergence (a card mentioning a not-yet-attached `context.ask`) is honest — the card is the constitution, the index is today's menu. A test asserts the index equals the canvasOps@2 registry so the *attached* claim never lies.
- **Change-feed `{changed}` as a fifth event kind** is not one of the four named user-act kinds, but R35 requires the stream to consume the feed; surfacing its notifications as ordered invalidation hints is the faithful minimal wiring and matches §3.2's "coverage stays current without re-describing".

## Migration Plan

Additive. New files only; three core re-exports and one adapter re-export. No change to existing modules, the dependency graph, or the gates.

## Open Questions

- Whether `{changed}` invalidation events should be surfaced to the model as-is or folded into a coalesced coverage delta — deferred to the E-series measurement; the seq-ordered delivery contract is stable either way.
