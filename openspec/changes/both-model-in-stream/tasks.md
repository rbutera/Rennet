# Tasks — both-model-in-stream (#297)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof each behaviour first. Only `packages/ui/src`. NO protocol/schema change — `review.ask` already carries `mode:"both"` + `secondOpinion`. Reuse `components/ask.tsx` (`AskControl` menu / `AskAnswers`) and `canvas/ask.ts` (`ASK_OPTIONS`, `DEFAULT_ASK_MODE`, `askCards`); do NOT re-implement the no-synthesis shape. No permission step on any ask (Rule Zero).

## 1. Study the substrate
- [ ] 1.1 Read `components/ask-panel.tsx` (mode state + `review.ask` invoke + `AskAnswers`), `components/ask.tsx` (`AskControl` split button/menu, `AskAnswers`/`askCards`), `canvas/ask.ts` (mode model + `askCards` no-synthesis guarantee), and `components/conversation-panel.tsx` `PanelSurface` (`askGeneral` ~235, composer ~423, `generalMessages` state). Confirm `askGeneral` already awaits the full `AskReviewResult` and drops `secondOpinion`.

## 2. Composer routing (one / both)
- [ ] 2.1 Give `PanelSurface` a `mode` state defaulting to `DEFAULT_ASK_MODE` (orchestrator). Add the one/both routing to the composer's Ask control — reuse `AskControl`'s split-button + caret menu pattern over `ASK_OPTIONS` (either mount `AskControl` in place of the bare send button, or mirror its menu). A plain Ask sends `mode:"orchestrator"`; picking "Ask both models" routes the next send to `"both"`.
- [ ] 2.2 `askGeneral(body)` takes the current mode and passes it to `bridge.invoke("review.ask", { mode, … })` (replacing the hard-coded `DEFAULT_ASK_MODE`). The anchored-thread `submit` path stays orchestrator-only (unchanged).

## 3. Render a both answer in the stream
- [ ] 3.1 When the result carries a `secondOpinion` (both asked), append ONE harness general entry that renders the comparison via the existing `AskAnswers`/`askCards` shape — orchestrator card then Codex card, labelled, with the "no synthesis · two answers · you decide" footer. Model the general message so it can carry the two cards (or the `AskReviewResult`) instead of a single body; an orchestrator-only result renders as the single message it does today.
- [ ] 3.2 CSS only: the two cards sit side by side when wide/expanded and stack in the 340px shell (`.ask-answer-cards` responsive). No content/shape change — two labelled answers at every width, never one merged answer.

## 4. Retire the standalone panel
- [ ] 4.1 Remove `<AskPanel>` from `app.tsx`'s review heart (~2097) and its import (~62). Delete `components/ask-panel.tsx` and its dedicated `ask-panel.dom.test.tsx` (behavior now lives in the panel). KEEP `components/ask.tsx` + `canvas/ask.ts` + their tests (now reused by the panel). Grep to confirm no other `AskPanel` importer remains.

## 5. Prove it
- [ ] 5.1 DOM tests on the panel: the composer offers one/both routing, default orchestrator; a plain Ask invokes `review.ask` with `mode:"orchestrator"` (assert the bridge arg).
- [ ] 5.2 Picking "both" invokes `review.ask` with `mode:"both"`; when the bridge returns a `secondOpinion`, the stream shows TWO labelled answer cards and NO merged/synthesis element, with the footer. Red-proof: reverting the both-render branch drops the second card and reddens.
- [ ] 5.3 An orchestrator ask still renders exactly one message and no second card. No permission step on either path (assert the ask runs straight through).
- [ ] 5.4 The standalone `AskPanel` is gone from the app (no second ask box in the review heart) and both-model is reachable from the one composer.
- [ ] 5.5 Full gate green; only `packages/ui/src` changed; state the tip sha + gate total.
