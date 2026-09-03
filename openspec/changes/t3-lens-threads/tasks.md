## 1. Seats on threads

- [x] 1.1 `t3/threads.ts`: seat bindings keyed on (repository root, generation id, seat) beside the session bindings; `supervisor.threadFor` takes the kind; thread titles name the branch and the lens
- [x] 1.2 `t3/client.ts`: `startTurn` accepts the output schema as T3's structured-output contract and `waitForTurnSettled` returns the settled turn's structured output, usage and duration; test against the real bundle
- [x] 1.3 `council-seat-turn.ts`: the T3 leg (`createT3SeatTurn`) on either provider via `modelSelection`; attempt 1 starts the thread's first turn, attempt > 1 a further turn; one `TurnMetric` per turn through the collector; seat start/settle lines in `daemon.log`
- [x] 1.4 `resolveBoardSeatDetails` routes every board job (`lens-draft*`, `board-post-process`, `round-report`) to the T3 leg; `runFlaggedDual` resolves two T3 seats on two providers
- [x] 1.5 `@rennet/prompts`: `renderRepairTurn(pointers, frozenIds)` as a partial; `draftOneLens` sends it as the repair turn instead of `renderRetryPrompt`; measure and record the per-repair token delta in the PR description
- [ ] 1.6 Run one real generation on a large branch; compare per-seat timings against the 2026-09-03 baseline in `benchmarks.jsonl` and record the numbers in `docs/developing/concepts/t3code-sidecar.md`
- [x] 1.7 `session.archive` deletes the session thread and every seat thread bound to the review, and drops the bindings; unarchive creates fresh threads on next use

## 2. Live lanes

- [x] 2.1 Protocol: `SessionPreparation` lanes carry `thread` and `latest`; command snapshot updated
- [x] 2.2 `t3/latest-event.ts`: pure projector from a thread's newest activity to a plain-words line (tool call, last sentence, idle), with tests including the 120-character cap and the "quiet for N s" state
- [x] 2.3 The seat leg holds the thread subscription while its lane runs and publishes `latest` through the lane at most four times a second; dropped on settle
- [x] 2.4 Capture publishes as the first lane of the same `SessionPreparation` (steps: resolving the repository, capturing the change) and the workspace route opens before capture completes

## 3. The bench

- [x] 3.1 `packages/app-ui`: replace `SessionPreparationScreen` with the bench as the workspace's first frame: the change as the slab, five readers with name, mark and live line, capture as the first beat, cancel; settled readers open into their boards in place; failed readers speak their reason. Creative liberty within `DESIGN.md`; not a table; every reader is a control
- [x] 3.2 DOM tests: a running reader shows its latest line and updates when the lane publishes a new one; a failed reader shows the reason; a settled reader is still a control; positive control on the "not a table" rule is a review question, not a test
- [x] 3.3 `@rennet/t3-chat`: `T3ThreadView` keyed by `{ environmentId, threadId, readOnly }`, composer hidden when read-only; `T3ChatSlotProvider` carries both the session view and the thread view
- [x] 3.4 Activating a reader opens its thread read-only in the chat slot and keeps streaming; the session's own thread is one control away

## 4. Delete the fallback layer

- [x] 4.1 Remove `chatEngine`: protocol key and schema, core registry, adapters pref fields, server pref and `offerChatEngine`, app-ui projection and `ChatEngineSection`, `create-server`'s engine switch; absence test on the parsed config
- [x] 4.2 Remove `ChatDock`, the ask stream in `chat-data.ts`, `review.ask`, `onAskStream`, the orchestrator session and primer; absence test on the command registry
- [x] 4.3 Remove the `SessionTurnLoop` handoff engine and `runHandoffTurnByEngine`; `runHandoffTurnT3` becomes `runHandoffTurn`; handoff tests re-pointed
- [x] 4.4 Remove the rung-one `<webview>`, `webviewTag`, CSP `frame-src`, and `pairingUrl` from `t3SessionSchema`; browser Vite config gets the alias, dedupe, defines and CSS bridge; the DOM test's webview branch becomes the native branch only

## 5. Documentation and specs

- [x] 5.1 `docs/developing/concepts/t3code-sidecar.md`: seats as threads, the bench, the latest-event projection, deletions; `handoff-and-exits.md`; the settings reference; `product-and-vision.md`'s spend line; `AGENTS.md` package boundaries and the effect/@t3tools seam sentence
- [x] 5.2 Archive `t3code-sidecar-chat` first so this change's `t3code-chat-surface` delta applies to a promoted spec; then validate this change strictly
