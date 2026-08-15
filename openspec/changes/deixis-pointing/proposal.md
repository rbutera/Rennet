# deixis-pointing — two-way pointing between the agent and the reviewer (#79)

## Why

A conversation about code is deictic: "this", "here", "that span" only resolve when both parties can point. Rennet has built both halves of the pointing machinery and wired **neither** end to end:

- **Agent → user is a dead letter.** `canvas.focus` exists as a canvasOps@2 op (`packages/core/src/canvas-ops.ts:580`) and emits a `{ kind: "focus", target }` effect; the MCP server forwards it (`packages/adapters/src/canvas-ops-server.ts:116`) into `reviewBackendCore`'s `applyEffects` — which **defaults to a no-op and is injected by no composition root** (`packages/core/src/review-backend.ts:107,316`). Meanwhile the inhabited CodeView (#77) already has the entire viewport mechanism the effect should land on: a `focusAnchor` prop, side-aware span resolution (`resolveAnchorToRows`, `packages/ui/src/canvas/registrar.ts:316`), a scroll-into-view effect that never fights the user's own scroll (`packages/ui/src/components/code-view.tsx:349`), and an accent pulse. The agent's finger and the surface it should point at are both built; the arm between them is missing.
- **User → agent points too coarsely, and not at all on the live path.** The context-update stream (#13) defines `{ selected }` at **element** granularity (`packages/core/src/context-update-stream.ts:33,58`), and nothing on the live turn path pushes it — `runOrchestratorTurn` never calls `session.buildRequest`, so a terse ask ("is this safe?") reaches the orchestrator with no idea what the reviewer is looking at. Yet the anchor grammar is already span-capable (`rennet:kind/id#L3-L9@side`, `packages/protocol/src/rsp.ts:299`) and the CodeView already has line/range click mechanics (#36's discuss gestures).

This change closes both halves with the smallest honest wiring: the agent's `canvas.focus` becomes a real viewport action (scroll + transient pulse), and the reviewer's span selection rides the next ask into the orchestrator's context at span granularity.

Deixis is presentational and gate-free (Rule Zero): it points, it never blocks, never asks permission, and never spends the user's attention ledger on their behalf — the focus tool's own contract says "NOTHING becomes read".

## What Changes

- **`canvas.focus` lands on the viewport.** The desktop composition root injects a real `applyEffects` sink; a focus effect is pushed main→renderer as a new `ask-focus` event on the existing ask-stream channel (keyed by `reviewId`), and the workspace routes it into the CodeView's existing `focusAnchor` machinery: scroll the resolved span into view and pulse it briefly. Purely presentational — no read-state event, no L2 write, no view-store `selection` mutation, no persisted highlight. An unresolvable target is an honest no-op (no pulse, no scroll, no guessed nearby anchor).
- **Span-granularity `{ selected }`.** The CodeView reports the reviewer's line/range selection as a minted span anchor (`rennet:<kind>/<occId>#Ls-Le@side`, via a new registrar helper that is the proven inverse of `resolveAnchorToRows`) plus the selected lines' text. The renderer carries it on `review.ask` as a new optional `selection` input field — **declared in the protocol Zod schema** (an undeclared field is silently stripped; a documented failure class here). Main pushes it as a `{ kind: "selected" }` user act into the orchestrator session's context-update stream, and the live turn renders the drained deixis events into the turn's context — lighting up the already-proven #13 request-assembly path on the live seam for the first time.
- **The interaction law holds.** The fixed-point rule (Design Doctrine, "The fixed-point rule") governs how the surface moves under the agent's finger: a focus jump moves the viewport deliberately and exactly once per pointing; it never re-fires on re-render and never fights the reviewer's own scroll (the existing row-keyed effect). Focus never masquerades as the user's selection — otherwise the agent's own pointing would echo back to it as user deixis.

## Capabilities

### New Capabilities

- `deixis-pointing`: the agent's `canvas.focus` resolved to a scroll + transient pulse on the inhabited CodeView, presentational-only invariants (no read-state, no L2, no selection mutation, honest no-op on an unresolvable target), span-anchor minting from the reviewer's selection, and span-granularity `{ selected }` carriage into the orchestrator's next-turn context over a Zod-declared IPC field.

### Modified Capabilities

<!-- None. canvasOps@2's op surface is unchanged (canvas.focus already exists with this contract); the context-update stream's event family is extended in place (an optional excerpt on `selected`, anchor strings already span-capable by grammar). No existing spec's requirements change. -->

## Scope

**In:**
- `canvas.focus(target)` → scroll + brief pulse of the resolved span in the open review's CodeView, via the ask-stream push channel.
- Reviewer span selection (existing line/range click mechanics) → minted span anchor + excerpt → `review.ask`'s new optional `selection` field → `{ selected }` act in the session stream → rendered into the live turn's context.
- The protocol Zod declarations for both crossings (`ask-focus` event variant; `selection` input field).
- The invariant proofs: presentational-only, fixed-point, honest no-op, schema round-trip/strip.

**Out (deferred, named):**
- Multi-span or multi-file focus (one target per `canvas.focus` call; the op already takes one).
- A focus history / back-stack ("where did the agent just point me from").
- Persistent highlights (pinnable agent marks are `canvas.annotate`'s job, not focus's).
- Anything that mutates disposition or read state from a pointing gesture.
- Live continuous view-state streaming (`{ viewing }` batcher on the live path, live `backend.view()` sync from the renderer): #13's remaining substrate. This change carries deixis **at ask time only** — the ask is already the deixis boundary (`orchestrator-session.ts:166`).
- Codex-slot parity for focus (the Codex ask is a one-shot exec with no canvasOps surface today).
- Cross-review / cross-canvas focus routing (a target outside the open review's canvases is an honest no-op in v1).

## Impact

- **`packages/protocol`** — `reviewAskStreamEventSchema` gains an `ask-focus` variant; `review.ask` input gains optional `selection { anchor, excerpt? }`. Hand-written Zod, round-trip + strip tests.
- **`packages/core`** — `{ selected }` act/event gains optional `excerpt`; no op-surface change (`canvas.focus` contract already correct).
- **`packages/ui`** — registrar gains the span-anchor minting helper (inverse of `resolveAnchorToRows`); CodeView gains `onSpanSelect`; workspace gains an externally-driven `agentFocus` input that pulses **without** selecting; app wires both to the bridge.
- **`packages/adapters`** — `runOrchestratorTurn` accepts pre-turn user acts and renders the session's drained deixis events into the turn context (using the proven `buildRequest` path).
- **`apps/desktop`** — the orchestrator runner injects the `applyEffects` focus sink; dispatch forwards `selection` and pushes `ask-focus` on the ask-stream channel.
- **Testability** — every seam is injectable (sink, stream, clock-free); the DOM tests prove pulse/scroll/no-op behavior; a whole-path test proves a focus effect emitted in main reaches the CodeView and a selection made in the CodeView reaches the turn's rendered context.
