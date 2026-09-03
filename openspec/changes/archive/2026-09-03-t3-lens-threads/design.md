## Context

See proposal.md for motivation. What exists today, and shapes the approach:

- The daemon owns one T3 sidecar per data directory (`packages/server/src/t3/supervisor.ts`), with a Promise-API client (`t3/client.ts`, the one server module importing `effect`/`@t3tools`) that already creates projects and threads, starts turns, waits for settlement, subscribes to thread events, and reads per-turn diffs. Thread bindings are keyed on (repository root, session id) in `<dataDir>/t3/thread-bindings.json`.
- Board seats run through `councilSeatTurn` (`packages/adapters/src/council-seat-turn.ts`): one ephemeral `createSession` + `send` per attempt, structured output via the SDK `outputFormat`, one repair turn per attempt that re-sends the base prompt on a cold session (`renderRetryPrompt`). Lanes publish coarse states (`queued`/`running`/`drafted`/`arrived`/`failed`) through `createRegenerationLanes`; nothing is emitted between `running` and `drafted`.
- The renderer has the rung-two native mount (`@rennet/t3-chat`): T3's `ChatView` under a memory router, keyed today by the session's bound thread, injected into `app-ui` through `T3ChatSlotProvider`. `ChatView` takes `environmentId` and `threadId` props and hosts `DiffPanel` itself.
- T3's server projects a thread as `OrchestrationThread` (messages, activities, latest turn state, checkpoints) and streams thread events over its RPC subscription; usage per turn is on the thread's turn records.
- Rule Zero: no consent gates. Threads persist in Rennet's own sidecar home, so persistence is a feature, not a disclosure problem.

## Goals / Non-Goals

**Goals:**
- One code path for every model-backed seat in the review pipeline: a T3 thread turn with an output schema.
- The preparation surface is something a reviewer wants to watch: each lens a presence with a live line, the transcript one click away.
- Delete, not deprecate: the `rennet` engine, the orchestrator chat, the ephemeral seat leg for board jobs, the webview.

**Non-Goals:**
- Moving the project scout, the repo map, the delta digest and other utility turns onto T3. They stay on the Claude/Codex adapters in this change; a follow-up moves them once the seat path is proven.
- Exposing canvasOps to T3 threads.
- Folding upstream T3 or sending the Claude structured-output patches upstream (group 4 of `t3code-sidecar-chat`, still pending Rai's word).
- Approvals inside lens threads: seats run full-access on the checkout, as today's seats do.

## Decisions

**A seat is a thread, bound by (generation id, seat id).** `t3/threads.ts` gains a second binding kind: `seat` bindings keyed on `(repositoryRoot, generationId, seat)` where seat ∈ {design, sequence, decisions, flagged-claude, flagged-codex, noise, round-report}. `supervisor.threadFor` learns the kind. The thread title names the review branch and the lens so the sidecar's own list reads sensibly. Alternative rejected: one thread per review with every seat as a turn on it; that serialises the seats and pollutes each seat's context with the others' output.

**`councilSeatTurn` gains a T3 leg and the board jobs use only it.** `CouncilSeatDeps` accepts a `t3: { client, threadFor }` seam; for board jobs (`lens-draft*`, `board-post-process`, `round-report`) `resolveBoardSeatDetails` resolves the T3 leg on whichever provider the council routed (Claude or Codex, via T3's `modelSelection`), with `outputSchema` attached to the turn as T3's structured-output contract. The Claude/Codex ephemeral legs remain for non-board jobs. `runTurn(prompt, attempt)` keeps its signature: attempt 1 starts the thread's first turn; attempt > 1 starts a further turn on the same thread. Alternative rejected: a new `HarnessPort` adapter for T3; the seat abstraction is already the seam and a port would re-encode T3's session model as ours.

**Repair is a pointer prompt.** `renderRepairTurn(pointers, frozenIds)` joins `renderRetryPrompt` in `@rennet/prompts`: the thread already holds the base prompt and the draft, so the repair turn carries only the lint pointers (each with its element id resolved by the caller), the frozen ids and the instruction to emit the corrected board. `renderRetryPrompt` stays for the ephemeral legs, which have no memory of the draft they are being asked to fix; `draftOneLens` picks between them on whether the seat runs on a persistent thread. Both of `renderRepairTurn`'s interpolations declare a byte bound. The measurement (before: base + draft + pointers re-sent cold; after: pointers only) goes in the PR description per AGENTS.md.

**Structured output has to be BUILT, not inherited.** The vendored T3 server carried no structured-output contract at all — group 4 of `t3code-sidecar-chat` was deferred and `PATCHES.md` was empty — so this change adds it: `outputSchema` on `thread.turn.start` (both command shapes) and the `thread.turn-start-requested` payload, threaded by the decider and the provider command reactor into `ProviderSessionStartInput` and `ProviderSendTurnInput`, and set as the SDK's `outputFormat` in the Claude adapter. The SDK fixes `outputFormat` at `query()` construction and offers no setter, so the contract is decided by a thread's FIRST turn and a later turn asking for a different one is refused by name — which costs nothing here, because a seat drafts and repairs against one board schema. Coming back, the settled turn's `structured_output`, `duration_ms`, usage and cost ride a `turn.settled` activity the runtime-ingestion layer projects from `turn.completed`; nothing in the thread projection carried a turn's own result before. Codex takes `outputSchema` natively through `V2TurnStartParams`, but its runtime does not surface a structured result, so the daemon parses the board out of a Codex seat's final message — for that provider only. Ten ledger rows, all upstreamable.

**Usage from T3, not from the SDK.** The T3 leg reads the settled turn's usage, cost and duration off the `turn.settled` activity above and records one `TurnMetric` per turn through the existing collector, labelled `board.<jobId>`. Claude's SDK reports usage CUMULATIVELY over a streaming session's turns, so the leg records each turn's own spend as the delta against the previous turn's total — otherwise a repair would bill the drafting turn a second time. Codex turns under T3 report tokens with no dollar figure, as today.

**Lanes carry a thread ref and a latest-event line.** `SessionPreparation` lanes (protocol) gain `thread?: { environmentId, threadId }` and `latest?: { kind: "tool" | "text" | "idle"; text: string; at: number }`. The daemon derives `latest` from the thread subscription the seat leg already holds: the newest activity of the latest turn, rendered in plain words by a small pure projector (`t3/latest-event.ts`: `Read src/foo.ts` → "reading src/foo.ts"; `Bash git diff …` → "running git diff …"; assistant text → its last sentence with an honest `…` cap at 120 characters). It is throttled to at most four publications per second per lane. Alternative rejected: the renderer subscribing to each seat thread directly through T3's RPC; that multiplies websockets per lane and puts the projection in the wrong place.

**The surface is the bench.** The preparation screen is the first frame of the workspace, not a separate route. Its centrepiece is the change itself (the branch name and the captured files as a slab on the bench) with the five lenses as distinct readers around it, each with a name, a mark and a live line of speech: what they are reading or saying now. A reader settles by turning into its board's opening in place; a reader that fails shows its reason in the same voice. Capture is the first beat of the same scene (the slab arriving), with cancel. The exact rendering (illustrated readers, a lantern per lens, an animated glance toward the file being read) is the implementer's creative liberty within `DESIGN.md`'s Affineur's Bench: warm grounds, one gold accent, serif for the readers' lines, motion only where it carries meaning. What is not open: it is not a status table, it never lies about state, and every reader is a control that opens its transcript.

**Read-only `ChatView`.** `@rennet/t3-chat` gains a `T3ThreadView` export keyed by an explicit `{ environmentId, threadId, readOnly }`, with the composer hidden through a wrapper style rule and prop (upstream `ChatView` has no read-only prop; the ledger gets a row only if a CSS-only hide proves insufficient, in which case the prop is added upstream-style and logged as upstreamable). The chat slot's provider becomes `T3ChatSlotProvider` with two components: the session view and the thread view. The router already carries the thread route, so a lens transcript is a navigation to `/$environmentId/$threadId` in the mount's memory router.

**Kill list, in one PR each after the seats land.** (1) `chatEngine`: protocol schema key, core registry, adapters `REPO_PREF_FIELDS`, server `PROJECT_PREF`, app-ui projection and `ChatEngineSection`, the docs. (2) `ChatDock`, `chat-data.ts`'s ask stream, `review.ask`, `onAskStream`, the orchestrator session and its primer (`orchestrator-session` spec removed). (3) `SessionTurnLoop` handoff engine and `runHandoffTurnByEngine`; `runHandoffTurnT3` becomes `runHandoffTurn`. (4) The rung-one `<webview>` branch, `webviewTag`, the CSP `frame-src`, and the pairing URL in `t3SessionSchema`; the browser Vite config gets the alias, dedupe, defines and CSS bridge the desktop has. Each deletion PR carries the test that proved the deleted path, converted to prove its absence where an absence is load-bearing (no `review.ask` command in the registry; no `chatEngine` key parsed).

**Flagged stays dual.** `runFlaggedDual` resolves two T3 seats, one per provider, on two threads; reconciliation is untouched.

## Risks / Trade-offs

- [T3's structured output on the Claude provider depends on the vendored patch (ledger row 1)] → the seat leg asserts the settled turn carries structured output and fails the turn honestly if not; the patch is already the sidecar's contract.
- [A seat thread per generation grows the sidecar's thread list quickly] → threads are titled and grouped by review; a later change adds pruning of generations older than the review's current patchset. Disk is cheap and the transcripts are the product.
- [Latest-event projection can lie by lag] → throttled, timestamped, and the presence shows "quiet for 40 s" past a threshold instead of freezing on a stale line.
- [Deleting the orchestrator chat removes the "ask Rennet about this review" affordance] → the T3 thread on the review's checkout is that affordance; the primer's map pointer is replaced by the checkout itself. Rai's ruling.
- [Read-only by CSS is bypassable] → it is not a gate; it hides a composer that would otherwise start a turn on a seat thread, which is merely confusing, not dangerous.
- [Two websocket subscriptions per seat (daemon holds them, renderer holds one for the open transcript)] → measured in the sidecar tests; the daemon subscription is dropped when the lane settles.

## Migration Plan

1. Seats on threads behind the existing lanes (no UI change): land, run one real generation, compare seat timings against the 2026-09-03 baseline in `benchmarks.jsonl`.
2. Lanes carry thread ref and latest event; the bench surface replaces `SessionPreparationScreen`.
3. Read-only thread view in the slot.
4. The four deletion PRs.
Rollback is `git revert` per PR; there is no data migration. Threads created by a reverted build stay readable in the sidecar.

## Open Questions

- Whether the round report should stay a thread or become a turn on the review's own thread (cheap either way; decided when the seat path is measured).
- ~~Thread pruning policy for old generations.~~ **Resolved (Rai, 2026-09-03):** archiving a session is the pruning act — `session.archive` deletes the session's own thread and every seat thread bound to that review's generations and drops the bindings, so a live session keeps every transcript it has and an archived one leaves nothing behind (task 1.7).
