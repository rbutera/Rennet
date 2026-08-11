# Design — Canvas state model (issue #10)

## The projection architecture

A `Canvas` is a **pure projection** over four independent inputs, assembled by `buildCanvas`:

| Layer | Source | Who owns it |
|---|---|---|
| L0 substrate | the `Decomposition` (chunks/hunks the canvas is about) | deterministic ingest |
| L1 analysis | admitted RSP documents + the decomposition (for DAG ordering) | deterministic projector |
| L2 disposition | the review's `Disposition[]` (already event-sourced by slice 1) | the user (sovereign) |
| L3 annotation | the canvas-op event stream (`foldCanvas`) | the orchestrator (ephemeral) |

Because every input is itself derived from the durable log (review events → dispositions; canvas events → L3; admitted docs are content-addressed by `docId`; the decomposition is deterministic from the patchset), the assembled `Canvas` is **byte-identical across replays** — acceptance criterion 1. `canvasDigest` (canonical JSON, the existing `payloadDigest` machinery) is how the replay test asserts it.

## L1 is a pure function of the admitted document + ordering rules

`projectAnalysis(angle, admittedDocs, decomposition)` filters admitted docs by a fixed `docType → angle` routing and places their elements:

- **decisions** ← `decision.record`: each decision anchors to a chunk; its **cohort** is that chunk (grouping is hard-baked, OQ17 closed); cohorts are ordered by the chunk's position in the decomposition reading order (candidate mechanism (c), Canvas Paradigm OQ2); within a cohort, stable by `decisionId`. **Never capped** — there is no `maxItems` anywhere.
- **sequence** ← `decomposition.proposal`: chunk elements in the admitted `readingOrder`; the proposal *is* this canvas's L1.
- **spec / claims / noise** ← `spec.model` / `claim` / `noise.patternProposal` + `anomaly`: doc-level elements placed deterministically (rich per-element bodies are #26).

Every element's identity is **derived, never minted**: `elementKey = sha256(docId, anchor)`. Same admitted docs projected twice ⇒ identical canvas — acceptance criterion 2. The blast-radius **overlay** is projected separately (proposal chunks whose angle set includes `blast-radius`); it paints amber and is never a writable layer.

## L2 is user-sovereign, enforced structurally

Two disjoint command vocabularies, both frozen consts:

- `USER_CANVAS_COMMANDS` — includes `canvas.disposition`, the **only** op that writes L2, plus `canvas.adjudicateProposal` (accepting a disposition proposal is a *user* act that produces a disposition), expand/collapse, select, pin/clear.
- `ORCHESTRATOR_CANVAS_OPS` — describe/view/focus/annotate/propose/recompute. Contains **no** disposition writer.

`dispatchOrchestratorCanvasOp` returns only L3/read effects; its type has no variant carrying a `DispositionSet`. The structural test enumerates the whole orchestrator vocabulary and asserts none of its effects is an L2 write and the vocabulary does not contain a disposition command — acceptance criterion 3. This is the same shape as issue #9's "no ordering-approval command" test.

## L3 is session-scoped

`foldCanvas(events)` applies the annotation lifecycle: `CanvasAnnotated` adds an ephemeral mark, `AnnotationPinned` promotes it, `AnnotationCleared` sweeps one, and `SessionEnded` drops every **unpinned** annotation while pinned ones survive (also clearing pending proposals) — acceptance criterion 4. Annotations added after a `SessionEnded` belong to the next session.

## Successor carry is exact-lineage only

`carrySuccessorDispositions(previous, nextPatchset)` reuses slice 1's `fileContentDigest`: a disposition survives only where the successor patchset still has a file at the same path whose patch is byte-identical. A changed file (a changed hunk within it) produces a different digest, so its approval **does not carry**; ambiguity fails closed and the element arrives unread — acceptance criterion 5. The calibrated fuzzy matcher (Spike 1) upgrades this seam later.

## The change feed is an invalidation hint, not a truth

`CanvasChangeFeed` (dependency-free, R35's one named feed): `publish({reviewId, canvasId, elementKey, seq, private})` buffers per `(canvasId, elementKey)`, coalescing by key so a conflated notification carries `seqRange {from: min, to: max}` — the covering range; `flush()` delivers one notification per buffered key to the canvas's subscribers; a **private** row is never published; the notification payload is exactly `{reviewId, canvasId, elementKey, seqRange}` — never a raw `EventEnvelope`. Buffers are bounded (`maxBufferedKeys`); on overflow the oldest key's buffer is dropped. A dropped notification is safe because the next delivered notification's `seqRange.from` jumps past the consumer's last-seen seq — the single **gap rule** (`from > lastSeq + 1 ⇒ re-query`) covers both overflow-drop and late subscription. The consumer re-queries the projection from the store (truth stays the store) — acceptance criterion 6.

## Files

- `packages/types/src/index.ts` — the canvas data model + change notification shape (types only, import-nothing boundary preserved).
- `packages/core/src/canvas.ts` — `canvasId`, `projectAnalysis`, `projectBlastRadius`, the canvas-op events + `foldCanvas`, `buildCanvas`, `canvasDigest`, `carrySuccessorDispositions`, the command vocabularies + dispatch.
- `packages/core/src/canvas-change-feed.ts` — `CanvasChangeFeed`.
- `packages/protocol/src/index.ts` — the user canvas IPC commands + the structural no-agent-L2-write test.

No dependency-arrow change; both gate directions (architecture, licenses) untouched.
