# Design — both-model-in-stream (#297)

## Where the seam is

`review.ask` already carries everything. `mode: "orchestrator" | "both"` goes in;
`AskReviewResult` comes back with `primary` always and `secondOpinion` only when both
were asked. The panel's `askGeneral` (conversation-panel.tsx ~235) already awaits the
full result and uses `result.primary` — it simply drops `result.secondOpinion`. So
this is a UI-only fold: pass the chosen mode in, and render the second card when it
comes back. No new command, no schema field, no `packages/protocol` touch.

## Composer routing

Reuse, don't rebuild. `components/ask.tsx` already has `AskControl` (a split Ask
button + caret menu over `ASK_OPTIONS`), and `canvas/ask.ts` has the mode model
(`DEFAULT_ASK_MODE`, `ASK_OPTIONS`). The panel composer today is a bare textarea +
Ask button. Give it a `mode` state (default `orchestrator`) and the same caret menu
so the reviewer can pick "Ask both models" per message. Keep the mode where the
composer's other draft state lives (`PanelSurface`), defaulting to orchestrator; a
plain Ask never routes to a second model (the wrong-side-safe default the schema and
router already enforce).

Scope note: routing applies to the **general** (un-anchored) ask — the both-model
comparison the standalone panel offered. Line/chunk/fragment thread replies keep the
orchestrator-only turn they have today; per-thread both-model routing is out of scope
here (the standalone panel never anchored either).

## Rendering a both answer in the stream

When `askGeneral` runs with `mode: "both"` and the result carries `secondOpinion`,
add ONE harness stream entry that renders the comparison via the existing
`AskAnswers` / `askCards` shape — the orchestrator card then the Codex card, each
labelled, with the "no synthesis · two answers · you decide" footer. `askCards`
yields at most two cards and has no merged element, so the #139 invariant stays
structural in the stream exactly as it was in the panel. An orchestrator-only ask
renders as the single message it does today.

Responsive: the two cards sit side by side when the panel is expanded/wide and stack
when narrow (340px shell) — a CSS concern on the existing `.ask-answer-cards`, never a
content change. Two labelled answers, never one merged answer, at every width.

The `general-ask` stream entries already live in `PanelSurface` local state
(`generalMessages`), so a both-answer is just a general entry whose body is the
comparison instead of a single text — model it as a general message variant that
carries the `AskReviewResult` (or its two cards), rendered by the comparison shape.

## Removing the standalone panel

Delete `<AskPanel>` from `app.tsx`'s review heart (~2097) and its import. The
`AskPanel` wrapper component + its dedicated test come out (its behavior now lives in
the panel); `AskControl`, `AskAnswers`, `askCards`, `ASK_OPTIONS` STAY (now reused by
the panel) with their tests. Verify no other importer of `AskPanel` remains.

## Rule Zero

One model or both, the ask just runs — no consent, no confirmation, no permission
step, at parity with the orchestrator-only path already in the stream. This adds no
capability the product didn't have; it relocates one into the unified surface.

## Tests

- Composer offers the one/both routing; default is orchestrator (a plain Ask sends
  `mode: "orchestrator"` — assert the bridge call).
- Picking "both" sends `mode: "both"`; when the result carries a `secondOpinion`, the
  stream shows two labelled answer cards and NO merged/synthesis element; the footer
  is present.
- An orchestrator ask still renders one message and no second card.
- The standalone `AskPanel` is gone from the app (no second ask box), and both-model
  is reachable from the one composer — red-proof: reverting the both-render branch
  drops the second card and reddens.
- Full `NX_DAEMON=false pnpm check` green; only `packages/ui/src` changed.
