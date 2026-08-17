# Design — adopt-conversation-rail

## Context

See proposal.md for motivation. Current state (verified against `main`):

- `ConversationMargin` (`packages/ui/src/components/conversation-cluster.tsx:375`) already accepts `diffRef?: RefObject<HTMLElement | null>`; `useRailAlignments` (same file, ~445) queries `diff.querySelectorAll("[data-anchor-key]")`, computes `rowTop - panelNaturalTop` per panel (undoing its own prior transform via `data-align-offset`), listens to diff `scroll`, window `resize`, and a guarded `ResizeObserver`, and omits off-window anchors (stacked fallback). Fully covered by `conversation-cluster.dom.test.tsx` with mocked multi-panel geometry.
- `CodeView` (`packages/ui/src/components/code-view.tsx`) renders windowed rows carrying `data-raw-index`/`data-side`/`data-file-line` but **no `data-anchor-key`**, and its scroll container ref (`scrollRef`, `.code-view-scroll`) is internal — nothing escapes to `CanvasWorkspace` or `app.tsx`.
- The review heart (`app.tsx` ~2601) renders `.diff-column > CanvasWorkspace(CodeView)` beside `ConversationPanel`. `ConversationPanel` (`conversation-panel.tsx:485`) renders through `ConversationHost` with a custom `render={PanelSurface}` — a flat chat stream — so the margin branch of `ConversationHost` (which renders `ConversationMargin`, currently without a diffRef) is never taken in the app.
- Anchor-key grammar lives in `canvas/conversation.ts`: `lineAnchorKey(path, side, line)`, `rangeAnchorKey`, `chunkAnchorKey(path)`, `fragmentAnchorKey`.

## Goals / Non-Goals

**Goals:**

- Make the shipped aligned rail the review heart's live conversation architecture: per-anchor panels, aligned when on-window, stacked otherwise.
- Zero diff reflow: alignment stays transform-only; the diff column's layout is untouched by adoption.
- Preserve every conversational affordance PanelSurface offers today (ask, promote, sub-thread, pending/error states).

**Non-Goals:**

- No change to anchor-key grammar, thread persistence, or the conversation bridge protocol.
- No fabricated positions for off-screen/range anchors (explicitly cut in #85; unchanged here).
- No removal of `PanelSurface` from the codebase in this change if another surface still uses it; the review heart simply stops rendering it. Dead-code deletion happens only if it is genuinely orphaned.

## Decisions

1. **Row identity: stamp `data-anchor-key` on CodeView content rows using `lineAnchorKey(path, row.side, row.fileLine)`; stamp `chunkAnchorKey(path)` on the chunk container.** The rail's lookup takes the topmost match per key, so duplicate keys across windowed re-renders are harmless. Range anchors are not exact-matched to a row — they degrade to stacked, which the spec calls honest. Alternative (computing a per-thread nearest row in the rail) was rejected: it fabricates a position for an anchor the diff is not actually showing.
2. **Ref exposure: add an optional `scrollRef` (or `diffRef`) prop to `CodeView` that receives the `.code-view-scroll` element; `CanvasWorkspace` forwards it; `app.tsx` owns one `useRef` at the review-heart split.** Alternative (context) rejected: one prop through two components is smaller and testable; a context invites unrelated consumers.
3. **Adoption path: `ConversationPanel` drops the `render={PanelSurface}` override in the review heart and takes the `ConversationHost` margin branch, with `diffRef` added to `ConversationHostProps` and forwarded to `ConversationMargin`.** The margin path gets whatever PanelSurface affordances are not already on `ConversationMargin` verified feature-by-feature (ask input, promote, sub-thread, pending, per-thread error) — `ConversationMargin` already carries `onPromote/onSubThread/onAsk/pendingThreadIds/errorByThread`, so this is a wiring check, not new UX. Alternative (teaching PanelSurface to align) rejected: it duplicates the alignment engine the cluster already owns and tested.
4. **Re-measure lifecycle: none added.** `useRailAlignments` already observes diff scroll/resize; the windowed renderer changes row presence on scroll, which the scroll listener already covers. If a windowing edge (rows swapped without a scroll event) shows up in the DOM tests, hook the existing registry version into the effect deps — but only on evidence.
5. **Testing: extend the existing DOM test surface, not a new harness.** New coverage: (a) CodeView rows queryable by `lineAnchorKey` under the exposed ref; (b) review-heart-shaped composition (CodeView + ConversationPanel with threads) aligns a line-anchored panel and stacks an off-window one; (c) no-reflow assertion reused from the shipped contract.

## Risks / Trade-offs

- [PanelSurface behaviours missing from the margin path (e.g. free-form chat rows not tied to an anchor)] → verify affordance parity in the wiring check; anything genuinely anchorless renders as a stacked panel in document order, which the contract already covers. If a real feature gap emerges, keep it in the margin rail as a stacked panel rather than resurrecting the flat stream.
- [Windowed rows recycle while the scroll position is unchanged (e.g. data refresh) leaving stale offsets] → alignment recomputes on effect re-run; if a stale case is demonstrated in tests, add the row-registry identity to the effect deps. Evidence-first, no speculative machinery.
- [Anchor-key duplication between the chunk container and content rows] → rail takes topmost match per key; chunk key and line keys never collide (different grammars).

## Open Questions

None — the #85 delivery already made the architectural calls (transform-only alignment, honest stacked fallback, no fabricated positions); this change executes the adoption #356 owns.
