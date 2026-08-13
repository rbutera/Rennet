# Fold the both-model comparison into the conversation stream (#297)

## Why

Frame-06 unified the review's right side into one chat stream (`ConversationPanel`),
but it left the both-model side-by-side comparison stranded in the standalone
`AskPanel`, still rendered as a separate block below the stream (`app.tsx` ~2097)
purely so the affordance wasn't lost. That is the last split surface: two ask boxes,
two mental models, in a UI whose whole point is one stream. This change finishes the
unification by moving the both-model comparison INTO the stream's composer and
retiring the dangling panel.

## What changes

- The panel composer gains a **one-model / both-models** routing on its Ask button
  (the same split-button + caret menu the standalone panel used), defaulting to the
  orchestrator so a plain send never fires a second model.
- Asking **both** renders, in the stream, the reviewer's question followed by ONE
  comparison entry: the orchestrator's answer and Codex's second opinion as two
  labelled cards, side by side — **never merged**. This reuses the existing
  `askCards` / `AskAnswers` shape, so the load-bearing "no synthesis, ever" invariant
  (#139) is carried by the same code that already guarantees it structurally, not
  re-implemented in the stream.
- The standalone `AskPanel` is removed from the review heart; its one/both control
  and answer-card shapes live on, reused by the panel. Nothing that could ask both
  models is lost — it moves into the one stream.

## Impact

- Affected: `packages/ui/src` only — `conversation-panel.tsx` (composer routing +
  both-model rendering), `app.tsx` (drop the standalone `<AskPanel>`), reuse of
  `components/ask.tsx` (`AskControl` menu / `AskAnswers`) and `canvas/ask.ts`.
- **No protocol / IPC change.** `review.ask` already accepts `mode: "both"` and
  returns `secondOpinion`; the panel already receives the full result and today
  ignores its second half.
- Rule Zero: asking one model or both just runs — no consent, no permission step.
  This is presentation unification, not a new capability and not a gate.
- Closes the both-model-relocation follow-up deferred on #297.
