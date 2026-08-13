# Tasks — conversation-panel (#297 / frame 06)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof each behaviour first. Only `packages/ui/src`. Reuse the conversation ENGINE — do not change `canvas/conversation.ts`, `review.ask`, or re-attach. No permission step on any ask (Rule Zero). Wireframe `06-review-heart` `.chat` is the authority.

## 1. Study the substrate
- [ ] 1.1 Read `components/conversation-host.tsx` (its state: threads, the turn driver, `autoOpenRequests`, re-attach), `components/ask-panel.tsx` (the general/both-model ask), `canvas/conversation.ts` (the thread/message + anchor model), and how `app.tsx` renders both in the `.review-heart-split` (ConversationHost in the margin, AskPanel below). Read the frame-06 `.chat` markup + CSS in `wireframes/src/review.mjs` for the exact target.

## 2. The unified ConversationPanel component
- [ ] 2.1 `components/conversation-panel.tsx`: owns the SAME state ConversationHost does (threads, turn driver over `review.ask`, auto-open discuss requests, re-attach), rendered as ONE chat stream — light `type-icon gutter + message` rows, no card boxes.
- [ ] 2.2 Per-message **ask-type icon** (comment / request-change / question / discuss / general-ask / finding) from the message's kind/anchor.
- [ ] 2.3 **Reply chip** on a line/range-anchored message: a quoted `path · Lx-Ly` + line text (frame-06 `.replychip` style); a general ask / file-level renders NO chip.
- [ ] 2.4 **One composer** — "Ask the orchestrator, or reply to a line…" — a general ask is an un-anchored turn; a line-reply carries its anchor. Both drive `review.ask` exactly as the current surfaces (orchestrator once, no permission step).
- [ ] 2.5 **Expand-to-fullscreen**: a header toggle that grows the panel over the review area and back (a CSS class on the panel), never altering the diff column's width (it is the flex sibling).

## 3. Wire into app.tsx
- [ ] 3.1 Swap `ConversationHost` for `ConversationPanel` in the `.review-heart-split`, same props (bridge, reviewId key, anchors, autoOpenRequests). Fold the general orchestrator-ask into the panel's composer.
- [ ] 3.2 **Preserve the both-model comparison** — do NOT delete `AskPanel`'s one/both side-by-side; keep it reachable (the least-disruptive wiring). Its relocation to the Questions overlay is deferred.
- [ ] 3.3 The diff column must NOT reflow when the panel opens/grows/expands (the flex-sibling contract).

## 4. Prove it
- [ ] 4.1 DOM tests: the panel renders ONE stream; a line-anchored message shows its reply chip AND its type icon; a general ask shows NO chip. Red-proof: reverting the anchor→chip branch makes the chip absent and the test reddens.
- [ ] 4.2 The live behaviour is preserved: opening a discuss thread on a line adds an anchored message; asking a general question adds an un-anchored one; both invoke `review.ask` (assert the bridge call), with NO permission step. Re-attach still restores threads (keep the existing conversation-host re-attach tests green, or port them).
- [ ] 4.3 Expand toggles the panel and back; the diff column width is unchanged across the toggle.
- [ ] 4.4 The both-model comparison is still reachable (a test or a read-verify that `AskPanel`'s both path is not removed).
- [ ] 4.5 Full gate green; only `packages/ui/src` changed; state the tip sha + gate total.
