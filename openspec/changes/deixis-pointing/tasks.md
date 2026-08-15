# Tasks — deixis-pointing

Ordered along the dependency arrows (`protocol` → `core` → `ui` → `adapters` → `apps/desktop`), red-proof-first inside each step. Gate before every push: `NX_DAEMON=false pnpm check` (must include the step's own positive control capable of failing).

## 1. Protocol: the two Zod crossings (`packages/protocol`)

- [ ] 1.1 Add the `ask-focus` variant to `reviewAskStreamEventSchema` (`src/index.ts:1051`): `{ kind: "ask-focus", anchor: z.string().min(1), threadId?: string, turnId?: string }` — `ask-*` kind family, hand-written, structural only (no anchor re-parsing in the schema; the grammar authority stays in `rsp.ts`). Round-trip test.
- [ ] 1.2 Add the optional `selection` field to the `review.ask` input (`src/index.ts:2037`): `selection: z.object({ anchor: z.string().min(1), excerpt: z.string().optional() }).optional()`. Round-trip test; back-compat test (an input without `selection` still validates — a #139/#251 ask is untouched).
- [ ] 1.3 **Strip red-proof** for the documented failure class: a test that parses a `selection`-bearing input against the field-less schema shape and asserts the field silently vanishes — proving the declaration is load-bearing, then the declared schema keeps it byte-identical.

## 2. Core: span-bearing `{ selected }` (`packages/core`)

- [ ] 2.1 Extend the `selected` `UserAct` and `DeliveredEvent` with optional `excerpt?: string` (`src/context-update-stream.ts:33,58`; delivery at `:252` carries it through verbatim). The anchor string is already span-capable by grammar — assert in a test that a span-bearing anchor (`rennet:occ/x#L2-L5@additions`) flows act→delivery unmodified.
- [ ] 2.2 Test `buildOrchestratorRequest` with a span-bearing `selected` event: the event appears in `contextEvents` verbatim and the rendered open-assembled-prompt line contains the exact anchor + excerpt bytes (invariant 9). Red-proof: truncate the excerpt in delivery and watch it fire.

## 3. UI registrar: minting the span anchor (`packages/ui`)

- [ ] 3.1 Add `spanAnchorForRows(registry, { line, side, endLine? })` (or rawIndices-based equivalent) in `src/canvas/registrar.ts` beside `resolveAnchorToRows`: map the clicked (fileLine, side) content rows to their occurrence and its **side-array ordinals** (never absolute file lines), minting `rennet:<kind>/<occurrenceId>#Ls-Le@<side>`. Returns a distinguished failure (not a throw) when the rows span occurrences or resolve to none.
- [ ] 3.2 **Round-trip property red-proof** (invariant 6): mint → `parseAnchor` → `resolveAnchorToRows` → exactly the originating rawIndices, on fixtures whose hunks do NOT start at line 1 and on an oversize-split occurrence. Red-proof: mint with absolute file lines first and watch the round trip fire; then fix to ordinals.

## 4. UI CodeView + workspace: both gesture ends (`packages/ui`)

- [ ] 4.1 CodeView: add optional `onSpanSelect?: (selection: { anchor: string; excerpt: string } | null) => void`, driven by the existing #36 line/range click state (`discussLine`/`rangeStart`) — a plain click reports the single-line span, a same-side shift-click the range, navigation reports `null`. Additive: absent callback ⇒ byte-identical rendering (existing DOM tests stay green as the control).
- [ ] 4.2 Workspace: add externally-driven `agentFocus?: { anchor: string; nonce: number }`. On change: set cursor + `focusAnchor` (+ zoom to the element's diff when the anchor's element is placed) — **never** `select()`. DOM test: focus pulses + scrolls the span (reusing the existing `focusAnchor` machinery).
- [ ] 4.3 Invariant tests, red-proof-first:
  - selection unchanged after agent focus (invariant 2; red-proof: route through `jumpToAnchor` verbatim, watch it fire);
  - no read-state event, no disposition write from a focus delivery (invariant 1);
  - unresolvable/malformed anchor ⇒ no pulse, no scroll, no throw (invariant 4; red-proof: fall back to row 0 on orphan, watch it fire);
  - re-render with same focus does not re-scroll; a user scroll after the jump is not yanked back; same-anchor re-focus with a new nonce re-pulses (invariant 3).
- [ ] 4.4 App: hold `currentSelection` from `onSpanSelect`, cleared on element/canvas navigation (invariant 10); attach it to the `review.ask` invoke; subscribe `bridge.onAskStream(reviewId)` for `ask-focus` and drive the workspace `agentFocus` (nonce increments per event).

## 5. Adapters: the live turn carries deixis (`packages/adapters`)

- [ ] 5.1 `runOrchestratorTurn` (`src/orchestrator-turn.ts`): accept optional `deps.userActs?: readonly UserAct[]`; after `attachOrchestratorSession`, push them into `session.stream`, then build the deixis block via `session.buildRequest(question, backend.view())` — the first live use — and append the rendered `viewContext` + `contextEvents` (one JSON line per event, the open-assembled-prompt shape) to the turn's context.
- [ ] 5.2 Tests (hermetic, injected SDK loader): an ask with a span selection produces a turn context containing the exact anchor + excerpt bytes; an ask with **no** selection contains **no** `selected` line (invariant 8; red-proof: default the act to the open element and watch it fire); an empty viewing batcher drains as a no-op.

## 6. Desktop main: the focus sink and the selection pass-through (`apps/desktop`)

- [ ] 6.1 Inject the effect sink at the composition root (`src/main/orchestrator.ts`, into `createDesktopReviewBackend`'s core state `applyEffects`): filter `kind === "focus"` and hand the anchor to an injected `onFocus(anchor)` — other effect kinds keep flowing to their existing (no-op) fate untouched.
- [ ] 6.2 Wire `onFocus` through the ask path (dispatch / `review-ask-live.ts`) to push `{ kind: "ask-focus", anchor, threadId?, turnId? }` on the ask-stream channel keyed by `reviewId` — the same webContents-send the token deltas use. Unit test with a fake sender: a focus effect during a turn emits exactly one schema-valid event with the op's target verbatim.
- [ ] 6.3 Thread the validated `selection` from the `review.ask` input through dispatch → the orchestrator runner as the `{ kind: "selected", anchor, elementSummary, excerpt, seq }` act (elementSummary from the placed element when resolvable, else the anchor string — never fabricated code text).
- [ ] 6.4 Whole-path tests: (a) a `canvas.focus` call on the live (fake-SDK) turn reaches a subscribed renderer listener as `ask-focus`; (b) a `review.ask` invoke carrying `selection` produces a turn whose context contains the span anchor — both ends of #79 proven across their real seams.

## 7. Gate

- [ ] 7.1 `NX_DAEMON=false pnpm check` clean, with the step-4/5 red-proofs recorded as having fired red before their fixes (the positive controls). No new lint/architecture exceptions; `ui` still imports only `types`/`protocol`/browser-safe deps.
