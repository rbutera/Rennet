# Design — deixis-pointing

## Ground truth (verified against the code, 2026-08-15)

What is already built and what this change may lean on:

| Piece | Status | Where |
| --- | --- | --- |
| `canvas.focus` op | **Built** — validates `target`, returns `{ focused }`, emits effect `{ kind: "focus", target }` | `packages/core/src/canvas-ops.ts:580-599` |
| Effect forwarding | **Built** — server applies outcome effects to the backend | `packages/adapters/src/canvas-ops-server.ts:116` |
| Effect sink | **Dead end** — `state.applyEffects` defaults to no-op; **no composition root injects it** | `packages/core/src/review-backend.ts:107,316` |
| Inhabited CodeView (#77) | **Built** — `focusAnchor?: string` prop; resolve → `focusRows`; scroll effect keyed on first focused row; per-row `isFocus` pulse class + accent pulse CSS | `packages/ui/src/components/code-view.tsx:70,325-363,429`; `packages/ui/src/canvas.css` ("the pointed-at span pulses in the accent") |
| Anchor→rows resolver | **Built** — side-aware, span-aware, four honest outcomes (resolved / no-occurrence / no-such-side / out-of-bounds) | `packages/ui/src/canvas/registrar.ts:316` |
| Workspace deixis state | **Built (internal only)** — `focusAnchor` state fed by `jumpToAnchor` (Flagged index rows, coverage chips), passed to CodeView | `packages/ui/src/components/workspace.tsx:331,700,1090` |
| Anchor grammar | **Span-capable already** — `rennet:kind/id#Lstart-Lend@side`; spans are 1-based ordinals **within the occurrence's side**, never absolute file lines | `packages/protocol/src/rsp.ts:286-340`; `packages/types/src/index.ts:508-523` |
| Context-update stream (#13) | **Core built & unit-proven; live path unwired** — `{ selected }` act/event at element granularity; `session.buildRequest` drains deixis at ask time; **`runOrchestratorTurn` never calls it and nothing pushes acts** | `packages/core/src/context-update-stream.ts:33,58,365`; `packages/core/src/orchestrator-session.ts:165-173`; `packages/adapters/src/orchestrator-turn.ts` |
| Main→renderer push | **Built** — ask-stream channel keyed by `reviewId`, survives renderer reload; Zod discriminated union `ask-delta` / `ask-complete` / `ask-interrupted` | `apps/desktop/src/preload/index.ts`; `packages/protocol/src/index.ts:1051` |
| Ask input | **Built** — `review.ask` already carries an optional thread `anchor` (`conversationAnchorSchema`) | `packages/protocol/src/index.ts:2037-2056` |

So: **#77 is built enough to build on** (this change adds no CodeView rendering machinery, only an external driver for what exists). **#13's core is built enough; its live plumbing is not** — this change deliberately lights up the smallest live slice (ask-time carriage through `buildRequest`) and defers the streaming rest.

## Seam 1: agent → user (`canvas.focus` → scroll + pulse)

The full signal path, op to pixel:

```
model calls canvas.focus { target }                      (in-process MCP, live ask turn)
  → focusTool.handle → effect { kind: "focus", target }   canvas-ops.ts:580
  → canvas-ops-server applies effects                     canvas-ops-server.ts:116
  → reviewBackendCore → state.applyEffects(effects)       review-backend.ts:316
  → NEW: desktop composition injects the sink             apps/desktop/src/main/orchestrator.ts
        (createDesktopReviewBackend deps.core.applyEffects)
  → NEW: filter kind === "focus" → push on ask-stream     dispatch/review-ask wiring, keyed by reviewId
        { kind: "ask-focus", anchor: target }             protocol: new union variant
  → renderer bridge.onAskStream(reviewId, …)              preload (unchanged), app.tsx subscription
  → NEW: workspace agentFocus = { anchor, nonce }         workspace.tsx prop
  → existing: setFocusAnchor + zoom-to-element-diff       workspace jump machinery (minus select())
  → existing: CodeView resolveAnchorToRows → pulse+scroll code-view.tsx:325-363
```

Decisions:

- **Transport is the ask-stream channel, not a new channel.** A focus effect only ever originates inside a live ask turn (the canvasOps server exists per turn), and the ask-stream channel is already keyed by `reviewId`, already crosses preload, and already survives a renderer reload. A new push channel would be plumbing for its own sake. The event is a new **Zod-declared** variant `{ kind: "ask-focus", anchor: string }` in `reviewAskStreamEventSchema` — kind literals stay in the `ask-*` family, disjoint from `projectProcessEvent` by the same rule the existing comment states. `threadId`/`turnId` are optional on this variant (a one-shot #139 ask has neither).
- **The workspace gets an externally-driven focus input that does NOT select.** The internal `jumpToAnchor` calls `store.getState().select(elementKey)` — correct for a user clicking an index row, **wrong for the agent**: if agent focus wrote `selection`, the agent's own pointing would echo back to it as user deixis (`viewContext.selection`, and eventually a `{ selected }` act) — a false "the user chose this". Agent focus sets cursor + `focusAnchor` (+ zoom to the element's diff when the anchor's element is placed, so the pulse is actually visible) and **never** `select()`. A `nonce` on the prop lets a repeated focus on the same anchor re-pulse (same-anchor state alone would be swallowed by React).
- **Unresolvable target = honest no-op.** `parseAnchor` failure or an orphan resolution (`no-occurrence` / `no-such-side` / `out-of-bounds`) pulses nothing, scrolls nothing, throws nothing, and never guesses a nearby anchor ("Anchors are home", Design Doctrine). The op itself still returns `{ focused }` to the model — the op's contract is "I pointed", not "the user's viewport obeyed"; v1 does not add a result round-trip (deferred with the focus back-stack).
- **Transience.** The pulse is a finite CSS animation on the focused rows; `focusAnchor` is cleared as the user moves on (existing workspace behavior). No persisted state, no store commit, nothing survives a reload. Persistent marks remain `canvas.annotate`'s job.

### Fixed-point / focus-rule invariants (testable properties)

1. **Presentational-only (the R30 focus rule; the tool's own contract "NOTHING becomes read").** Delivering a focus effect produces: zero read-state `ViewEvent`s (in particular, spans scrolled past by an agent jump emit no `ScrolledPast`/skimmed — read-state is defined by *user* actions only, `packages/ui/src/canvas/read-state.ts`), zero L2 disposition writes, zero store commits. *Test:* drive `agentFocus` through the workspace; assert the disposition set and the read-state event source are byte-identical before/after.
2. **Focus never mutates `selection`.** After an agent focus, the view store's `selection` is unchanged. *Test:* select element A, agent-focus an anchor in element B, assert `selection === A` (while cursor/zoom moved). *Red-proof:* route agent focus through `jumpToAnchor` verbatim and watch this fire.
3. **One deliberate move per pointing; never a fight.** The scroll effect fires when the resolved first row changes or the nonce advances — a re-render with the same focus does not re-scroll, and a user scroll after the jump is never yanked back (the existing row-keyed effect, `code-view.tsx:354-356`, extended with the nonce). *Test:* focus, simulate user scroll, re-render, assert `scrollTop` unmoved.
4. **Honest no-op.** A malformed or unresolvable anchor produces no pulse row, no scroll change, no throw. *Red-proof:* make the handler fall back to row 0 on orphan and watch the no-op test fire.
5. **No gate (Rule Zero).** The focus lands with no confirmation, no consent step, no "the agent wants to show you something" dialog. There is no test for the absence of a dialog beyond the DOM test asserting the pulse appears synchronously with the event; the invariant is a review-time law.

## Seam 2: user → agent (span selection → next-turn context)

The full signal path, click to prompt:

```
reviewer clicks / shift-clicks rows (existing #36 gesture state)   code-view.tsx discussLine/rangeStart
  → NEW: CodeView onSpanSelect({ anchor, excerpt } | null)
        anchor minted by NEW registrar helper:
        spanAnchorForRows(registry, { line, side, endLine? })
        → "rennet:<kind>/<occurrenceId>#Ls-Le@<side>"              inverse of resolveAnchorToRows
  → app holds currentSelection; cleared on element/canvas nav
  → ask time: invoke("review.ask", { …, selection: { anchor, excerpt } })
        NEW optional Zod field on review.ask input                 protocol/src/index.ts:2037
  → dispatch → review-ask-live → orchestrator runner
  → NEW: runOrchestratorTurn deps.userActs: push
        { kind: "selected", anchor, elementSummary, excerpt, seq } into session.stream
  → existing (first live use): session.buildRequest(question, backend.view())
        drains viewing, consumes next-turn events                  orchestrator-session.ts:165
  → rendered deixis block (viewContext + contextEvents, one JSON line
        per event — the open-assembled-prompt shape) appended to the
        turn's context                                             orchestrator-turn.ts systemAppend
```

Decisions:

- **The grammar does the heavy lifting; "span granularity" is carried in the anchor string.** `{ selected }` already carries `anchor: string`, and the RSP grammar already expresses spans — so the core event shape needs only an optional `excerpt?: string` (the selected lines' text, so "is this safe?" arrives with the code it is about). `elementSummary` stays what it is (the human-readable element name). No protocol grammar change, no new event kind.
- **Span ordinals are occurrence-relative, not file lines.** `AnchorSpan` is "1-based WITHIN the anchored unit" — so minting must map the clicked (fileLine, side) rows back to their occurrence and its side-array ordinals. That inverse lives beside the resolver in `registrar.ts` where the data already is (`occurrence.sides[side]` raw indices). *The property test is the round trip:* mint from rows → `parseAnchor` → `resolveAnchorToRows` → exactly the originating `rawIndices`. *Red-proof:* mint with absolute file lines and watch the round trip fire on any hunk that doesn't start at line 1.
- **Carriage is ask-time, not a live stream.** Sessions are booted fresh per turn (`fresh: true` in `runOrchestratorTurn`), and "ask time IS the deixis boundary" is the session's own documented law. A standing renderer→main act stream would be #13's remaining substrate — deferred. One field on the ask the renderer already sends is the smallest honest carrier, and it reuses the ask's existing back-compat convention (all-optional additions).
- **`selection` is distinct from the thread `anchor`.** `review.ask`'s existing `anchor` names the *thread's home* (a #36 conversation anchored to a line/range/chunk). `selection` is *ambient deixis* — what the reviewer had selected when they asked, whatever surface the ask came from. A thread ask may carry both; a main-conversation terse ask carries only `selection`. Main never fabricates one from the other.
- **Zod declaration is load-bearing.** The invoke path validates against the protocol schemas; an undeclared field is silently stripped (the documented failure class). Both crossings (`ask-focus` variant, `selection` field) are declared, with a round-trip test and a **strip test** (build the input with the field, parse with the *old* schema shape in test, assert it vanishes — proving why the declaration exists) plus a rejection test for a malformed anchor string (non-`rennet:` scheme is refused at the schema edge with `.refine(parseAnchor(...).ok)`? — no: the schema stays structural (`z.string().min(1)`); *semantic* validation is the renderer's minting + main's honest pass-through, and the model-side resolver already treats junk honestly. A schema that re-parses anchors would duplicate the grammar authority in a second place).
- **The turn renders deixis visibly and inspectably.** The drained events render one JSON line each after the primer — the same byte-for-byte inspectable shape `renderOpenAssembledPrompt` established (DSL §6.3 doctrine): no paraphrase, no summarized-away selection.

### Invariants (testable)

6. **Round trip** (above): minted span anchor resolves back to exactly the rows the reviewer selected, side-aware.
7. **Schema honesty:** `selection` and `ask-focus` survive their IPC crossings byte-identically; the strip test documents the failure class they guard against.
8. **No fabrication:** an ask with no selection produces a turn context with **no** `{ selected }` event — never an empty-looking or element-guessed one. *Red-proof:* default `selection` to the open element and watch this fire.
9. **Deterministic rendering:** the same acts render the same deixis block bytes (the stream is already seq-deterministic; the render is a pure fold).
10. **Selection is transient renderer state:** cleared on element/canvas navigation; never persisted; never a store commit.

## What this change assumes vs builds

- **Assumes (#77):** the CodeView's registrar, resolver, `focusAnchor` pulse + scroll machinery — all present and tested. This change adds only: the `onSpanSelect` callback, the minting helper, and the external `agentFocus` driver.
- **Assumes (#13 core):** `ContextUpdateStream`, `UserAct`/`DeliveredEvent`, `buildOrchestratorRequest`, `session.buildRequest` — present and unit-proven.
- **Builds (the missing live slice):** the `applyEffects` injection, the `ask-focus` push + renderer routing, the `selection` IPC field, the act push + `buildRequest` use on the live turn path. This is the first live use of the #13 request assembly; the `{ viewing }` batcher and continuous view sync stay deferred and are *not* prerequisites (the drain of an empty batcher is a no-op).

## Alternatives rejected

- **A new dedicated focus push channel** — plumbing duplication; the ask-stream channel already has the right key, lifetime, and preload crossing.
- **Routing focus through the renderer's `jumpToAnchor` unchanged** — mutates `selection`; the agent would manufacture its own user deixis (invariant 2's red-proof).
- **Extending `conversationAnchorSchema` for selection** — that wire shape is the #36 thread-home (kind/label/key/context for placement-on-reattach); ambient deixis needs exactly an RSP anchor + excerpt, and the RSP string is already the canonical cross-layer pointer.
- **A live renderer→main act stream now** — builds #13's remaining substrate inside a pointing change; ask-time carriage delivers the product value ("is this safe?" disambiguated) at a fraction of the surface.
