# Design — conversation-panel (#297 / frame 06)

## Reuse the engine; reshape only the surface

The conversation ENGINE already exists and is live: `canvas/conversation.ts` owns the thread/message model, `ConversationHost` drives each turn over `review.ask`, anchors align threads to lines/ranges/chunks, and re-attach restores persisted threads (#251). **None of that changes.** This is a presentation reshape — a new component renders the SAME model as one chat stream instead of stacked thread cards + a separate ask box. Building on the existing model keeps the live behaviour (real turns, anchoring, re-attach, orphaning) intact by construction.

## `ConversationPanel` — one stream

A new `components/conversation-panel.tsx` that owns the same state `ConversationHost` does (the threads, the turn driver, the auto-open discuss requests) but renders it as frame 06's `.chat`:

- **The stream** is the flattened, time-ordered set of messages across all threads plus the general orchestrator asks. Each message row is a light `type-icon gutter + message` (no card).
- **The ask-type icon** maps the message's kind to the kit's icon set (comment / request-change / question / discuss / general-ask / finding). A per-message `kind` already exists on the disposition/thread model or is derivable from the thread's anchor/verb; carry it onto the rendered row.
- **The reply chip** renders when a message is line/range-anchored: a quoted `path · Lx-Ly` + the anchored line text, styled as frame 06's `.replychip` (a left-border quote). A chunk/file-level or general ask renders no chip.
- **The composer** is one input — "Ask the orchestrator, or reply to a line…". Submitting with no active line context is a general ask (an un-anchored turn); submitting from a line's discuss affordance carries that anchor (the existing `autoOpenRequests` / discuss-glyph path feeds it). Both call the SAME `review.ask` turn the current surfaces use.
- **Expand** is local UI state: a header button toggles a `panel--expanded` class that grows the panel over the review area (CSS), and back. It must not alter the diff column's width contract — the panel is the flex sibling, and expand grows the sibling, so the diff never reflows.

## What `app.tsx` changes

In the review-heart split (`.review-heart-split`), swap `<ConversationHost .../>` for `<ConversationPanel .../>` with the same props (bridge, reviewId keyed remount, anchors, autoOpenRequests). Fold the general-ask entry into the panel's composer, so the separate below-split `AskPanel` general-ask box is no longer the only way to ask. **Keep the both-model comparison reachable** — do not delete `AskPanel`; leave its both-model side-by-side path available (its relocation to the Questions overlay is the deferred follow-up). The cleanest interim: keep `AskPanel` for the explicit "compare both models" affordance and let the unified panel own the orchestrator conversation. The implementer picks the least-disruptive wiring that (a) makes the review-heart conversation one stream and (b) does not lose the both-model comparison.

## Honesty (Rule Zero)

The reply chip is a real render of the message's actual anchor — never a decorative quote on an un-anchored message (that would be a lie about where the reply lands). Asking a model just runs — no permission step, no consent, no are-you-sure — exactly as the current surfaces do. Expand is a plain layout toggle, never a gate.

## What stays untouched

`canvas/conversation.ts` (the model), the `review.ask` command, re-attach/persistence, the diff/lens rendering, and the both-model `AskPanel` comparison. The reshape is confined to how the review-heart conversation is presented.
