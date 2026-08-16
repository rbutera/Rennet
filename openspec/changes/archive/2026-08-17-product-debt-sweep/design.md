# Design — product-debt-sweep

## Context

See proposal.md for the per-debt evidence. Three of the five debts carry a real technical decision; the other two (#71 close-with-evidence, #158 comment fix) need none.

## Goals / Non-Goals

Goals: honest executor provenance (#88), the claims lens gone without stranding persisted reviews (#221), raw markdown reachable without abandoning the structured-first viewer (#239).

Non-goals: no new narration consumers for #71 (refresh/capture waits stay busy states until they earn narration), no lazy-trigger rework for the flagged run (#158 — eager stays), no redesign of the provenance model beyond the three re-stamp sites.

## Decisions

### 1. #88 — executor facts ride the turn result, runner still owns the envelope

The division of labour stays as issue #88 prescribes: the runner owns the envelope, budget, and floor; the port runs one attempt. The `emitted` variant of `HarnessTurnResult` (`packages/core/src/harness-run-turn.ts:27`) gains an optional field carrying the executor's provenance facts — route, tier, and the per-call capability snapshot. `createCodexRunTurn` fills it from the port's already-built honest provenance (`codex-utility-port.ts` `buildProvenance`); the Claude `createHarnessRunTurn` may leave it absent. The three runner `buildProvenance` sites (`angle-generation.ts`, `ordering-pass.ts`, `finding-generation.ts`) prefer the turn's executor facts when present and fall back to today's defaults (`agentic`/`heavy`/seed capability) when absent.

Why this over having the port emit the whole envelope: the runner-owned envelope is deliberate (seed identity, docId/inputDigest minting, floor fallback); moving envelope assembly into the port would be a larger contract change for zero extra honesty. Additive-optional keeps every existing mock and test valid.

### 2. #221 — retired angle is rejected going forward, normalized away on read

`claims` leaves `ChunkAngle`, `CHUNK_ASSIGNABLE_ANGLES`, and the V104 closed set, so newly produced docs cannot declare it. But patchsets are immutable and reviews persist: a decomposition doc admitted before this change may carry `claims` in a chunk's angle list. Decision: the persistence read path strips retired angle values from chunk angle lists before validation/typing (a one-line normalization with a named constant for retired angles), so an old review still opens; a chunk whose only angle was `claims` simply stops appearing on any angle queue (it remains reachable through sequence/reading order, which covers every chunk). Re-validating old docs against the shrunk set and rejecting them would turn a UI retirement into data loss — the wrong trade.

The `claim` docType goes too (types union, protocol docType list, `canvas.ts` routing): it has no producer and, with the lens gone, no destination. Nothing persisted carries it (no producer ever emitted one outside fixtures), so no read-path handling is needed.

Alternative considered: keep `claims` in the type unions but hide the lens. Rejected — Rai's verdict names the unions explicitly, and a type that lies about the product's shape is exactly the debt this sweep exists to delete.

### 3. #239 — raw text carried alongside the parsed model, toggle lives in the viewer

The adapter already reads the artifact files off disk to feed `parseOpenSpecChange` (`OpenSpecChangeArtifacts`). The `openspec.change` command result carries those raw strings alongside the parsed model (additive field; existing consumers unaffected). The viewer holds one boolean of view state and a keystroke handler registered through the existing UI keybinding seam; raw view renders the visible artifact's text in a `<pre>`-style block. No markdown re-rendering, no serializer — the escape hatch shows the file as it is, which is the point.

### 4. #158 — eager stays, the comment tells the truth

The flagged auto-run on review open is intended MVP behavior, ceilinged by `createInvocationBudget`. A lazy on-lens-open trigger would withhold the product's core output until the user performs a ritual — a gate by another name. Decision recorded here; the code change is rewriting the `app.tsx:890` comment to describe the budgeted spend honestly.

## Risks / Trade-offs

- [Old review renders differently: a claims-only chunk leaves the angle queues] → It stays reachable via the sequence canvas (reading order covers all chunks); the claims queue it sat on no longer exists by product decision.
- [A future Codex-executed path forgets to fill executor facts and silently gets `agentic`/`heavy` defaults] → The red-first tests for #88 pin the codex path end-to-end (`createCodexRunTurn` → runner → stamped provenance), so a new path copying that wiring inherits the test shape.
- [Raw-view keystroke collides with an existing binding] → Registered through the existing keybinding seam, which surfaces conflicts; pick an unclaimed key at implementation time.

## Migration Plan

Single branch, single PR, `pnpm check` green before push. No data migration: normalize-on-read handles legacy docs at load time, nothing is rewritten on disk.
