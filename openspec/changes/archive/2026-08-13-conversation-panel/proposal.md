# conversation-panel

**Issue:** #297 (the frame-06 follow-up). **Owner:** Claude (Zone A / renderer). **Review:** dual (Opus + Codex).
**Wireframe:** v4.0 `06-review-heart` — the unified `.chat` conversation panel. **Depends on:** navigation-wayfinding (merged).

## Why

The v4.0 wireframes (frame 06) reshape the review's right side into **one lightweight chat-style stream** — the piece deferred from #297. Today the review heart carries two separate conversation surfaces: `ConversationHost` (line/range/chunk-anchored discuss threads, in the right margin) and `AskPanel` (a general "ask about this review" box below the split). Two boxes, two mental models. Frame 06 unifies them: one stream where a reply to a line and a question to the orchestrator sit side by side, each tagged by an icon, line-anchored ones wearing a Messenger-style reply chip.

## What Changes

Per frame `06-review-heart`'s `.chat` panel:

- **One unified `ConversationPanel`** replacing `ConversationHost` in the review-heart right column. It renders the conversation as **one chat stream** — no boxy thread cards.
- **An icon per message ask-type** (comment / request-change / question / discuss / general-ask / finding) in a small gutter, so you read what kind of message it is at a glance.
- **Line-anchored messages wear a reply chip** — a quoted line reference above the message (`keys.ts · L44-47` + the line text), WhatsApp/Messenger reply style — so an anchored thread reads as "a reply to this line", visually distinct from a general ask, in the same stream.
- **One composer** — "Ask the orchestrator, or reply to a line…" — folding the general orchestrator ask (today's `AskPanel` orchestrator path) into the stream. A general ask is just a message with no reply chip; a line-reply carries its anchor.
- **Expand to full screen** — a header affordance that grows the panel to fill the review area and back, for a long conversation.
- It stays the diff column's **flex sibling** (the diff never reflows when the panel grows), preserving the shipped `.review-heart-split` contract.

## Acceptance

- The review heart shows ONE conversation stream (no separate margin-threads + ask-box). A line-anchored message renders with its reply chip (the line reference); a general orchestrator ask renders without one. Each message shows its ask-type icon.
- Opening a discuss thread on a line/range/chunk (the existing diff discuss glyphs) adds an anchored message to the stream; asking the orchestrator a general question adds an un-anchored one. Both drive `review.ask` exactly as today (orchestrator once; no permission step — Rule Zero).
- Expand-to-fullscreen toggles the panel to fill the area and back; the diff column never reflows on open/grow.
- Red-proof: a line-anchored message MUST render a reply chip and a general ask MUST NOT (revert the anchor-branch → the chip disappears and the test reddens).
- The both-model side-by-side comparison (`AskPanel`'s "both" mode) is **preserved and reachable** — it is not deleted.
- Full gate green.

## Impact

- **`packages/ui/src`** only. A new `components/conversation-panel.tsx` (the unified stream + composer + expand), reusing the existing conversation MODEL (`canvas/conversation.ts` threads, the `review.ask` turn driver) so the live behaviour is unchanged — this is a presentation reshape, not a new engine. `app.tsx` swaps `ConversationHost` for `ConversationPanel` in the review-heart split and folds the general-ask composer in. New/updated DOM tests + CSS (reuse frame 06's `.chat` vocabulary). Zone A.
- No protocol/core/adapters/desktop-main change — the ask/thread commands are untouched.
- Dual review (Opus + Codex): verify the live conversation behaviour (turns over `review.ask`, thread anchoring, re-attach) is preserved through the reshape, the reply-chip vs general-ask distinction is honest, expand never reflows the diff, and no ask introduces a permission step.

## Deferred

- **Fully folding the both-model comparison** (`AskPanel`'s one/both side-by-side) into the stream or relocating it to the Questions overlay (frame 14 / the nav model's overlay). This change keeps the both-model comparison reachable as-is; unifying it is a separate follow-up so the side-by-side isn't lost or half-migrated.
- Any change to the conversation ENGINE (turn model, re-attach, persistence) — this is presentation only.
