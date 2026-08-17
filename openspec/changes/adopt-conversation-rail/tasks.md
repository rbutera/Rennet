# Tasks — adopt-conversation-rail

## 1. Diff-side anchor identity and ref exposure

- [x] 1.1 Stamp `data-anchor-key={lineAnchorKey(path, row.side, row.fileLine)}` on CodeView content rows (rows with a real side + file line only; import from `canvas/conversation.ts`), and `data-anchor-key={chunkAnchorKey(path)}` on the chunk container element.
- [x] 1.2 Add an optional ref prop to `CodeView` exposing the `.code-view-scroll` element; forward it through `CanvasWorkspace`; verify no behavior change when the prop is absent.
- [x] 1.3 DOM test: render CodeView with a real registry, assert a known line's row is discoverable via its `lineAnchorKey` under the exposed ref, and that an out-of-window line's key finds no element.

## 2. Conversation-side diffRef threading

- [x] 2.1 Add `diffRef?: RefObject<HTMLElement | null>` to `ConversationHostProps`; forward it to `ConversationMargin` in the host's margin branch.
- [x] 2.2 Add `diffRef` to `ConversationPanelProps`; thread to `ConversationHost`.
- [x] 2.3 Switch the review heart's `ConversationPanel` render path from the `PanelSurface` override to the host's margin branch, verifying affordance parity (ask, promote, sub-thread, pending, per-thread error) — anchorless content renders as stacked panels in document order.

## 3. Review-heart wiring

- [x] 3.1 In `app.tsx`, own one diff ref at the review-heart split, pass it into `CanvasWorkspace`/`CodeView` and into `ConversationPanel`, preserving the sibling-column structure.
- [x] 3.2 DOM test at review-heart shape: CodeView + conversation column with two threads — the on-window line-anchored panel aligns (`translateY`, `data-align-offset` from its own natural top), the off-window one stacks, and the diff column's node positions are unchanged by thread growth (no-reflow).
- [x] 3.3 Confirm windowed-scroll re-measure: scrolling the diff so an anchor row leaves the window drops the panel back to stacked in the same test surface.

## 4. Gate and docs

- [x] 4.1 If `PanelSurface` is now genuinely orphaned, delete it and its styles; otherwise leave it and note the remaining consumer. **Done:** `PanelSurface` and its now-dead helpers (`ChatRow`, `TypeIcon`, `anchorReply`, `messageType`, the flat-stream state) were the review heart's only consumer; `conversation-panel.tsx` is now the thin margin wrapper, and the orphaned `.conversation-panel*` / `.chat-*` / `.replychip*` styles were removed from `styles.css` (the still-used `.conversation-panel-shell` sibling rule stays). The global `.ask-answers[data-count="2"]` two-column rule stays — `AskAnswers` is still rendered by the OpenSpec viewer.
- [x] 4.2 Update affected docs in the same change (delivery-order note for #356; any using-docs page describing the conversation column).
- [x] 4.3 Run `pnpm check` (full gate, positive control included); fix findings; verify clean.
