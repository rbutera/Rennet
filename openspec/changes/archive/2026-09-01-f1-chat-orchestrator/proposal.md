# F1 — the chat orchestrator answers for real (#570, RELEASE BLOCKER)

## Why

`packages/server/src/review-ask-live.ts:100-108` — `askOrchestrator()` returns a canned string:

```ts
return {
  model: ORCHESTRATOR_ASK_LABEL,
  answer: "The orchestrator is unavailable during the Board rebuild.",
};
```

The blocker it names (B2) landed long ago. The gate cleared and nobody came back. The deferral is
recorded only in `b10 tasks.md:27`, and the in-code comment reads as a deliberate design decision —
which is exactly the camouflage that hid it.

The chat dock is the product's headline surface. It is mounted permanently
(`routes/layout.tsx:110`), its composer says *"message the orchestrator"* (`composer.tsx:234`), and it
is the first thing the product owner will try in the release he auto-updates onto. Right now that
surface accepts a question and answers with build vocabulary. Honest-present binds this: a surface
must be structurally CAPABLE of showing what it advertises, and the canned string is itself the
failure mode — it reads deliberate.

**The finding is understated. There are two defects, not one, and the second is worse.**

The issue says the user path is "fully live end to end". It is not. `useChatDock()` reads its
`reviewId` from `SessionTranscriptContext` (`chat-data.ts:369`), a **test-only** context whose
provider is mounted in three `.dom.test.tsx` files and **nowhere in the running app** — `layout.tsx`
renders `<ChatDock />` bare. So in the real product `reviewId === undefined`, and `send()` returns at
its first guard (`chat-data.ts:485`) **before** `ask.mutate` is ever called. The typed message does not
reach the canned string; it reaches nothing at all. The stub comment naming the swap ("cluster 7
resolves it from the real route instead", `chat-data.ts:142`) describes work that never happened.

**A third defect makes the fix invisible even once both are repaired.** The Claude adapter maps
`stream_event` → `text.delta` (`claude-adapter.ts:436`) and advertises the `textDeltas` capability
(`:517`), but `toSdkOptions` never sets the SDK's `includePartialMessages`
(`claude-query.ts:107-145`). The SDK does not emit partial-message frames unless asked, so a real
`claude` turn produces **zero** `text.delta` events. Every `ask-delta` frame, the seq-guarded fold, the
mid-turn reattach cursor, and the streaming bubble are live plumbing with no source. Without this the
dock would sit silent for the whole turn and then paste the answer whole.

Everything else on the path is real and proven, and this change reuses all of it: the `askReview`
router's law (orchestrator once, "both" adds Codex, never a synthesis), the `ask-delta` /
`ask-complete` / `ask-interrupted` stream, thread persistence with the streaming placeholder and the
abort guard, the live-turn registry and `before-quit` reaping, and attention (`ask-pending` /
`turn-failed`). None of it changes here.

## What Changes

The shape is **wiring, not a new subsystem**. There is exactly one orchestration path and this change
does not add a second: the live turn runs through `claudeHandoffRunPort` — the same
`HarnessPort.createSession` → `send` → drain → `session.close()` port B11 cluster 4 already runs a
composed work order through (`create-server.ts:1846` → `runHandoffTurn` at `:1674` →
`claudeHandoffRunPort(adapter)` at `:1706`) — resolved through the same memoized
`claudeAdapterForRepo` seat probe the pipeline uses. The ask does **not** take the checkpoint bracket:
`runHandoffTurnCore` exists to measure a *write* turn's diff, and an ask measures nothing.

1. **Partial-message streaming, opt-in.** `SessionSpec.streamPartialText?: boolean` →
   `ClaudeQueryOptions.includePartialMessages` → the SDK option. Opt-in rather than always-on so the
   pipeline's lens/utility turns keep their exact current frame volume — no blast radius outside the
   ask. The adapter's existing `text_delta` / `thinking_delta` mapping is already correct; it just has
   never been fed.
2. **`onDelta` on the run port.** `HandoffRunInput` gains an optional `onDelta`, and
   `claudeHandoffRunPort` calls it on each `text.delta` while it drains. Four lines in
   `packages/adapters`, and the write-handoff path is unaffected (it passes no `onDelta`).
3. **`createLiveOrchestratorAsk`** in `review-ask-live.ts`, the structural sibling of the
   `createLiveCodexAsk` already in that file: resolve the review's Claude adapter, compose a
   review-grounded prompt (the reviewer's question, the repository root, the active patchset's branch
   and base/head, and the bounded raw diff through the existing `truncateToBytes` helper), run ONE
   turn at `review.repositoryRoot`, stream `onDelta`, thread `abortController`, and return the final
   text as an `AskAnswer` under `ORCHESTRATOR_ASK_LABEL`. A failed turn returns the port's real
   reason; no harness installed returns an honest unavailable line naming `claude`. Never a
   fabricated answer.
4. **Bind it in `create-server.ts`** — `createLiveReviewAskPorts` gains its `askOrchestrator` dep
   alongside the `askCodex` one already there, and the canned string is deleted with its stale
   comment.
5. **The chat dock resolves the live review** so `send()` stops being a no-op. `useChatDock()` falls
   back to resolving the route's session slug when the (test-only) projection context supplies no
   `reviewId`. The resolution lives in `chat/chat-data.ts` — **not** `routes/layout.tsx` — so the dock's
   always-mounted lifetime and the shell chrome are untouched.
6. **Chat turns survive a reload.** Dispatch persists a turn only when the ask carries an `anchor`
   (`dispatch/review.ts:205`), and the dock sends none — so a real answer would still vanish on
   reload, and `review.reattach` (the dock's own read) would return empty. The dock sends the
   `fragment` anchor the wire schema already carries for "anchors to a message, not code"
   (`wire.ts:1170`). No protocol change.
7. **Live E2E + docs**, including the positive control.

## Out of scope — with the reason, not a shrug

**`buildAppTools` stays unconsumed (cluster 7 is OPTIONAL and droppable).** Confirmed: it is exported
from `packages/server/src/index.ts:12` and referenced only by `agent-tools.test.ts`. Binding it into a
Claude turn is **not** wiring — `SessionSpec` carries no tool/MCP field and `ClaudeQueryOptions` has no
`mcpServers`, so it needs the SDK's in-process `createSdkMcpServer` + `tool()` threaded through core →
adapters, `mcp__rennet__*` appended to `SESSION_ALLOWED_TOOLS` (`claude-adapter.ts:49`), the command
registry's Zod v4 arg schemas converted to the SDK's tool-schema form (the `claude` CLI's ajv rejects
draft-2020-12; `claude-query.ts` already normalizes output schemas for exactly this reason), and
`dispatch` late-bound into the deps object it is constructed from. That is a real build with a live
proof, and it is separable: an orchestrator that reads the repository and answers is a true
orchestrator. Dropping cluster 7 does not make any surface lie — it only means chat cannot yet *act*
on the app. Ship it here if the schedule allows; otherwise file it and land clusters 1–6.

**Tool and thinking activity are not surfaced.** The dock's element registry has `ActionStepData` and
`ThoughtBlockData`, but `ReviewAskStreamEvent` carries only delta/complete/interrupted. Feeding
`tool.started` / `thinking.delta` into the dock needs new protocol wire variants — a `packages/protocol`
edit that collides with c21's lane for no release-blocking gain. A turn with no action rows renders no
action rows; that is absence, not a false claim. Deferred.

**`onFocus` stays unwired.** `LiveReviewAskPorts.askOrchestrator` accepts it and nothing calls it
today; scroll-to-anchor needs a tool the orchestrator can invoke, which is cluster 7's territory.
Leaving it unwired is the status quo, not a new lie.

**No consent gate, no spend confirmation, no "are you sure this will cost a turn".** Asking a model is
Rennet's job. The turn runs on the user's own subscription through their own `claude` binary. Rule
Zero.

## Decisions (part of the spec — hold these, do not re-open)

1. **One orchestration path.** The ask turn goes through `claudeHandoffRunPort`, the port B11 cluster 4
   already drives. If an implementer finds themselves writing a second session drain loop, that is the
   wrong answer — extend the port.
2. **No checkpoint bracket on an ask.** `runHandoffTurnCore` measures a write turn's diff. An ask has
   no diff to measure, and bracketing it would create git refs for a question.
3. **The turn is capable by default.** It gets the adapter's full default tool surface, Bash included
   (`claude-adapter.ts:44-59`). An orchestrator that cannot read the repository it is being asked about
   answers worse. "Do not commit or push" is prompt instruction, matching the handoff precedent — not
   a withheld capability.
4. **Partial-message streaming is opt-in per session.** The ask sets it; pipeline turns do not. Zero
   change to lens/utility/compose turn behaviour.
5. **The chat-dock reviewId resolution lives in `chat/chat-data.ts`.** Not `routes/layout.tsx`. The dock
   is the single data-resolution point by its own header contract, and keeping the edit inside `chat/`
   keeps the merge surface disjoint from concurrent shell-chrome work.
6. **`agenticPort` is deleted, not wired.** Confirmed dead: declared at `create-server.ts:492`,
   assigned at `:518`/`:538`/`:560`, read nowhere. It builds a `CodexAdapter` for an agentic Codex seat
   that does not exist; the orchestrator is Claude. Deleting it is the honest read of a dead field. If
   the cluster-3 diff needs to shrink for a merge, this task drops without affecting behaviour.
7. **The router's law is untouched.** `askReview` still asks the orchestrator exactly once, adds Codex
   only in "both", and never synthesizes. This change supplies a port behind that law; it does not
   move the law.

## Verification (positive controls that can fail)

- **Cluster 1:** an adapter test asserting `toSdkOptions` sets `includePartialMessages` only when
  `streamPartialText` is set, plus a session-level test driving a fake `queryFn` that emits a
  `stream_event` frame and asserting a `text.delta` event arrives. **Positive control:** drop the
  option and the delta assertion fails.
- **Cluster 2/3:** hermetic tests with a fake `HarnessPort` — a completed turn returns its final text
  under `ORCHESTRATOR_ASK_LABEL`; deltas reach `onDelta` in order; a failed turn returns the port's
  real reason; a null adapter returns the honest no-harness line. **Positive control:** the existing
  `review-ask-live.test.ts` assertion on the canned string must be *deleted because it now fails* —
  if it still passes, nothing was wired.
- **Cluster 5/6:** a dom test mounting `ChatDock` on a real session route with **no**
  `SessionTranscriptProvider` and asserting `review.ask` is invoked through `MemoryBridge`.
  **Positive control:** this test fails on `main` today (send is a no-op). Plus a reload test: the
  transcript survives because the turn persisted.
- **Cluster 6 E2E, driving the real app:** open a review, type a real question in the chat dock, watch
  tokens stream in, get a grounded answer that references the actual diff. **Positive control:** relaunch
  the daemon with `RENNET_DISABLE_HARNESS=1` (the existing hermetic hook — `claude-query.ts:216` returns
  a null adapter) and the dock reports an honest unavailable answer naming the missing harness — never a
  plausible-sounding answer, never a silent hang.
- `pnpm check` green.

## Completion sigil

`<promise>F1-COMPLETE</promise>`
