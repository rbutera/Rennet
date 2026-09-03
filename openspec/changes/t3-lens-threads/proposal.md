## Why

The review pipeline still runs its lens seats through Rennet's own harness adapter: one cold, ephemeral `claude` session per lens, no cap, no stream, nothing logged, and a repair that re-sends the whole base prompt on a fresh session. On 2026-09-03 three Opus lenses spun for more than fifteen minutes on a large branch and the only UI was five spinners; Rai could not tell a hung seat from a slow one from the app, the daemon log, or `ps`. The vendored T3 Code sidecar already exists on the daemon, keeps durable threads with streamed tool calls, and has a native `ChatView` mount in the renderer. Rai's direction (2026-09-03): T3 is the backend for everything, the `rennet`/`t3` engine switch was never asked for, and the preparation screen must show what each lens is doing live.

## What Changes

- **Every board seat is a T3 thread.** Design, Sequence, Decisions, Flagged (both seats), Noise and the round report each run as one persistent thread on the review's project in the daemon-owned sidecar, one thread per seat per review generation. Threads are not ephemeral: the sidecar's home is Rennet's own data directory, never the user's `~/.t3`, so durable transcripts are the point, not a leak.
- **Repair is a follow-up turn on the same thread.** A draft that fails lint gets "the draft failed lint: `<pointers>`, fix it" as the next turn; the base prompt is never re-sent cold. The output schema still travels once, as T3's structured-output contract for the turn.
- **The preparation surface shows the seats live.** Capture is the first lane on the same screen; each lens row shows the latest event from its thread (the current tool call, or the last thing the agent said) as it streams; clicking a row opens the full transcript as a read-only `ChatView` in the chat slot. The workspace opens immediately; there is no separate "Capturing the change" page.
- **BREAKING: the fallback layer is removed.** The `chatEngine` setting and its control, Rennet's own chat dock and the `review.ask` orchestrator session, the `SessionTurnLoop` handoff engine, and the rung-one `<webview>` are deleted. Every host mounts the native `ChatView`; every work order runs as a T3 turn; the browser build gets the same Vite alias the desktop has.
- **Seat spend and timing come from T3.** Per-turn usage and duration on each thread feed the existing metrics collector and the benchmark store, so a lens has a real number attached rather than a post-hoc guess.
- **Flagged's primary seat is Opus** (already routed in `model-council.ts`); the Codex second seat stays, as a T3 thread on the Codex provider.
- The daemon-side seam stays `packages/server/src/t3/client.ts`; the renderer-side seam stays `@rennet/t3-chat`. No third module imports `effect` or `@t3tools/*`.

## Capabilities

### New Capabilities
- `t3-lens-threads`: every board seat and the round report runs as a persistent T3 thread on the review's project in the daemon-owned sidecar; repair is a same-thread turn; each thread's usage and timing reach the collector.
- `board-preparation-surface`: the preparation screen opens immediately with capture as its first lane and one live row per lens, and a row opens that seat's transcript read-only in the chat slot.

### Modified Capabilities
- `lens-board-drafting`: a lens seat settles from a T3 thread turn, and a repair continues that thread instead of opening a cold session.
- `round-regeneration-reveal`: a lane carries the seat's latest event while it runs; retry budgets count same-thread turns.
- `handoff-bundle-composition`: the run always executes as one T3 turn on the review's thread; the engine choice is gone.
- `orchestrator-session`: removed; the review's conversation is its T3 thread.
- `mobile-shell`: the phone's live-turn and ask-answer requirements are removed with the command they rode; an ask push lands on the review.
- `t3code-chat-surface` (from the in-flight `t3code-sidecar-chat` change, which must be archived first): the per-project chat engine setting is removed and the slot always renders the native thread view.

## Impact

- `packages/server`: `runtime/lens-pipeline.ts` and `runtime/rounds.ts` route seats through the T3 supervisor; `dispatch/review.ts` loses `review.ask`; `create-server.ts` loses the engine switch and the `SessionTurnLoop` path; the sidecar supervisor grows thread-per-seat binding and a thread-event tail per lane.
- `packages/adapters`: `council-seat-turn.ts` gains a T3 leg and loses the ephemeral-session leg for board jobs; the Claude and Codex adapters remain for the scout, the map and utility turns until a later change moves them.
- `packages/protocol`: `SessionPreparation` lanes carry a thread ref and a latest-event line; `settingsProjectPrefsSchema.chatEngine` and the `chat.*` orchestrator commands are removed; `daemon.status.t3Sidecar` stays.
- `packages/app-ui`: `SessionPreparationScreen` becomes the first frame of the workspace; `ChatDock`, `chat-data.ts`'s ask stream, `engine-chat-dock.tsx`'s webview branch and the Chat engine settings section are deleted; `T3ChatSlotProvider` is required by every host.
- `packages/t3-chat`: a read-only mode for `ChatView` (composer hidden) and a mount keyed by an arbitrary thread, not only the session's bound thread.
- `apps/desktop` and the browser build: the same Vite alias, defines and CSS bridge, and both entries provide `T3ChatSlotProvider`.
- `apps/mobile`: the turn screen, the timeline reducer, the ask-reply composer, the shade-answer path and the background answer task go with `review.ask`; `onAskProjection` (the ask LOG) stays.
- `@rennet/prompts`: the lint-repair turn prompt as a partial; the base lens prompts are unchanged.
- Docs: the sidecar and chat-surface concept pages, the handoff-and-exits concept, the settings reference, product-and-vision's honest-copy line about spend, `AGENTS.md` package boundaries.
- Users who set `chatEngine` in `.rennet/config.json` have that key ignored (Rai is the only user).
