# Tasks — adopt-conversation-rail

## 1. Diff-side anchor identity and ref exposure

- [x] 1.1 Stamp `data-anchor-key={lineAnchorKey(path, row.side, row.fileLine)}` on CodeView content rows (rows with a real side + file line only; import from `canvas/conversation.ts`), and `data-anchor-key={chunkAnchorKey(path)}` on the chunk container element.
- [x] 1.2 Add an optional ref prop to `CodeView` exposing the `.code-view-scroll` element; forward it through `CanvasWorkspace`; verify no behavior change when the prop is absent.
- [x] 1.3 DOM test: render CodeView with a real registry, assert a known line's row is discoverable via its `lineAnchorKey` under the exposed ref, and that an out-of-window line's key finds no element.

## 2. Conversation-side diffRef threading

- [x] 2.1 Add `diffRef?: RefObject<HTMLElement | null>` to `ConversationHostProps`; forward it to `ConversationMargin` in the host's margin branch.
- [x] 2.2 Add `diffRef` to `ConversationPanelProps`; thread to `ConversationHost`.
- [x] 2.3 Switch the review heart's `ConversationPanel` render path from the `PanelSurface` override to the host's margin branch, verifying affordance parity (ask, promote, sub-thread, pending, per-thread error) — anchorless content renders as stacked panels in document order. **Done:** the anchorless "ask the orchestrator" affordance is restored as `GeneralAskPanel`, a stacked rail citizen pinned at the end of `ConversationMargin` (via a `railFooter` slot; it is not a `.conversation-cluster`, so the alignment engine never offsets it). It fires the same `review.ask` boundary with both-model routing, and PRESERVES the reviewer's typed question on a failed turn (design Goals: "Preserve every conversational affordance PanelSurface offers today"; risk remedy: "keep it in the margin rail as a stacked panel rather than resurrecting the flat stream"). The both-model result renders as two labelled cards — the same unsynthesised two-card contract the anchored clusters use — so the retired inline comparison card is not needed. The cluster + general composers share one extracted `AskComposer`.

## 3. Review-heart wiring

- [x] 3.1 In `app.tsx`, own one diff ref at the review-heart split, pass it into `CanvasWorkspace`/`CodeView` and into `ConversationPanel`, preserving the sibling-column structure.
- [x] 3.2 DOM test at review-heart shape: CodeView + conversation column with two threads — the on-window line-anchored panel aligns (`translateY`, `data-align-offset` from its own natural top), the off-window one stacks, and the diff column's node positions are unchanged by thread growth (no-reflow).
- [x] 3.3 Confirm windowed-scroll re-measure: scrolling the diff so an anchor row leaves the window drops the panel back to stacked in the same test surface. **Review-round hardening:** the rail now re-measures on a `requestAnimationFrame` AFTER the windowed rows commit (a same-tick scroll read the rows the scroll replaced), the diff element flows to the rail through React state via a callback ref so a CodeView unmount/remount re-subscribes against the live element (not a detached node), the alignment engine tests each anchor row's rect against the diff VIEWPORT box (`diff.getBoundingClientRect()`) and stacks any row scrolled outside it — subsuming the chunk case, so the top spacer stays keyed at every depth and no `range.start` key-gate is needed (the 8-row overscan holds `range.start` at 0 while the spacer top is already ~144px off-viewport), and same-anchor threads share one group offset so they flow beneath the aligned row instead of collapsing onto one coordinate. Covered by eight DOM tests in `app-review-heart-align.dom.test.tsx` (aligned/off-window, scroll-only re-measure, remount re-subscribe, chunk-stacks-within-overscan, chunk-stacks-deep-scroll, same-anchor group offset, no-reflow row positions) plus a CSS-contract test `app-review-heart-reflow.css.test.ts` pinning the fixed-width rail sibling (`flex: none`) and the flexible diff column (`flex: 1 1 auto; min-width: 0`) so flipping the sibling to flexible reddens.

## 4. Gate and docs

- [x] 4.1 If `PanelSurface` is now genuinely orphaned, delete it and its styles; otherwise leave it and note the remaining consumer. **Done:** `PanelSurface` and its now-dead helpers (`ChatRow`, `TypeIcon`, `anchorReply`, `messageType`, the flat-stream state) were the review heart's only consumer; `conversation-panel.tsx` is now the thin margin wrapper, and the orphaned `.conversation-panel*` / `.chat-*` / `.replychip*` styles were removed from `styles.css` (the still-used `.conversation-panel-shell` sibling rule stays). The global `.ask-answers[data-count="2"]` two-column rule stays — `AskAnswers` is still rendered by the OpenSpec viewer.
- [x] 4.2 Update affected docs in the same change (delivery-order note for #356; any using-docs page describing the conversation column).
- [x] 4.3 Run `pnpm check` (full gate, positive control included); fix findings; verify clean.
