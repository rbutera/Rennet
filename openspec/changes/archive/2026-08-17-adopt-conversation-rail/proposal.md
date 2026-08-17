# Adopt the aligned conversation margin rail in the review heart

## Why

The aligned `ConversationMargin` component shipped in the design-usability pass (#85) with its full `diffRef` contract, alignment math (`rowTop - panelNaturalTop`), and DOM test coverage — but it is dormant. The review heart renders a flat `PanelSurface` chat stream beside `CodeView`, no diff ref is threaded, and no CodeView row carries the `data-anchor-key` the rail's lookup queries, so the live app never aligns a conversation panel to the code it discusses. Issue #356 is the app-level adoption decision: make the shipped rail the review heart's live conversation architecture.

## What Changes

- `CodeView` content rows gain `data-anchor-key` (line-anchor grammar via `lineAnchorKey(path, side, fileLine)`), and the chunk container carries its `chunkAnchorKey`, so the rail's `[data-anchor-key]` lookup finds real rows. Range-anchored threads that match no single rendered row degrade to the honest stacked fallback — never a fabricated position.
- `CodeView` exposes its diff scroll container upward through a ref prop; `CanvasWorkspace` forwards it; the review heart in `app.tsx` owns the ref at the CodeView boundary.
- `ConversationPanel` and `ConversationHost` gain an optional `diffRef` prop threaded down to `ConversationMargin`; the review heart's conversation column renders the aligned margin path (per-anchor panels, aligned when the anchor row is on-window, stacked otherwise) instead of the flat `PanelSurface` stream, preserving ask/promote/sub-thread affordances.
- The sibling-column no-reflow structure is unchanged: alignment transforms panels only, never the diff column. Re-measure rides the already-shipped scroll/resize/ResizeObserver lifecycle over the windowed diff.
- No new gate, no confirmation, no publish-path change (Rule Zero): a mis-aligned or absent anchor renders stacked and reachable, never hidden.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `canvas-ui`: the "App-level threading of the diff ref is outside this delta" boundary closes — the review heart SHALL thread a live diff ref from `CodeView` through `ConversationPanel`/`ConversationHost` into `ConversationMargin`, CodeView rows SHALL carry the anchor-key identity the rail queries, and the review heart's conversation column SHALL render the aligned margin path with the honest stacked fallback.

## Impact

- `packages/ui/src/components/code-view.tsx` — row `data-anchor-key`, exposed scroll-container ref.
- `packages/ui/src/components/workspace.tsx` — forward the diff ref.
- `packages/ui/src/components/conversation-panel.tsx`, `conversation-host.tsx` — `diffRef` prop threading; review-heart render path becomes the margin.
- `packages/ui/src/app.tsx` — own the ref at the review-heart split, pass it down.
- Existing DOM tests (`conversation-cluster.dom.test.tsx`) keep covering the component contract; new coverage proves the app-level threading (CodeView rows queryable by anchor key, ref arrives at the margin, no-reflow preserved).
- No protocol, core, or persistence change. No new dependency.
