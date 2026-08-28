# Tasks — f1-chat-orchestrator (F1, #570 RELEASE BLOCKER)

Read `openspec/BUILD-LOOP.md` first, then `proposal.md` (its **Decisions** section is part of the
spec). One cluster per session; the repo compiles and the gate is green after every cluster; one
commit per checked task. Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless
stated; full gate `sh -c 'pnpm check'` at cluster 6.

**Reused surfaces (confirm on `main` at session start — do NOT re-implement):**

- `packages/adapters/src/handoff-run-live.ts` — `claudeHandoffRunPort`. **The** turn port: one
  `createSession` → `send` → drain `events` → `session.close()`, with error/cancel mapped to an honest
  failure. B11 cluster 4 already runs a composed work order through it. The ask reuses it as-is plus
  one optional callback. **Do not write a second drain loop.**
- `packages/server/src/create-server.ts:1674` `runHandoffTurn` — the composition-root example of
  resolving a locus, getting the adapter, and calling the port. The ask reuses the *pattern*, not the
  function (no checkpoint bracket — Decision 2).
- `packages/server/src/create-server.ts:579` `claudeAdapterForRepo(repoRoot)` — the memoized,
  locus-aware Claude seat probe. This is how the ask gets its adapter. Already exists; do not add a
  second resolver.
- `packages/server/src/review-ask-live.ts` — `createLiveCodexAsk` is the **structural sibling** to
  mirror: injected deps, prompt builder, honest failure, no throw into the router. `truncateToBytes`
  and `activePatchsetOf` in that same file are reused by the orchestrator prompt.
- `packages/core/src/review-ask.ts` `askReview` — the routing law. **Untouched** (Decision 7).
- `packages/server/src/dispatch/review.ts:139-400` — the whole `review.ask` handler: streaming,
  `liveTurns` registry + abort, thread persistence with the streaming placeholder and the abort guard,
  attention raise/clear. **All live. Untouched except the client now supplies an anchor (cluster 5).**
- `packages/adapters/src/claude-adapter.ts:430-455` — `stream_event` → `text.delta` / `thinking.delta`
  mapping. Already correct; it has simply never been fed.
- `packages/app-ui/src/routes/slug.ts` `useSlugResolution` — the documented single swap point for
  slug → reviewId. Cluster 4 consumes it; it does not re-derive review identity.
- `packages/protocol/src/wire.ts:1162-1172` `conversationAnchorSchema` — already carries
  `kind: "fragment"` for an anchor that hangs on a message, not code. Cluster 5 uses it; **no protocol
  change in this whole task list.**

**Session-start bearing (run these; each must still hold, or re-scope before writing code):**

```sh
sed -n '100,108p' packages/server/src/review-ask-live.ts          # the canned string
grep -rn "includePartialMessages" packages/adapters/src           # expect: NO hits
grep -rn "SessionTranscriptProvider" packages apps --include=*.tsx | grep -v test  # expect: only the index.ts re-export
grep -rn "buildAppTools" packages apps --include=*.ts | grep -v agent-tools        # expect: only index.ts:12
grep -n "agenticPort" packages/server/src/create-server.ts        # expect: 492/518/538/560 — declared+assigned, never read
```

---

## 1. Partial-message streaming — make `text.delta` actually arrive (Decision 4)

- [ ] 1.1 `packages/core/src/harness.ts`: add `readonly streamPartialText?: boolean` to `SessionSpec`,
  documented as "ask the harness to emit incremental text/thinking frames; absent ⇒ settled messages
  only". Opt-in by design so the pipeline's lens/utility/compose turns keep their exact current frame
  volume. No other core change.
- [ ] 1.2 `packages/adapters/src/claude-adapter.ts`: add `readonly includePartialMessages?: boolean` to
  `ClaudeQueryOptions`, and thread `spec.streamPartialText` into it in `#buildOptions` (the same
  `...(x === undefined ? {} : { x })` style the neighbouring fields use). Nothing else in the adapter
  changes — the `stream_event` → `text.delta` / `thinking.delta` mapping at `:430-455` is already
  correct.
- [ ] 1.3 `packages/adapters/src/claude-query.ts`: in `toSdkOptions`, set
  `sdkOptions.includePartialMessages` when the option is present. One line, mirroring the `resume`
  passthrough directly above it.
- [ ] 1.4 Tests in `claude-query.test.ts` + `claude-adapter.test.ts`: `toSdkOptions` omits the SDK
  option by default and sets it when asked; a session created with `streamPartialText: true` driven by
  a fake `queryFn` that yields a `content_block_delta` / `text_delta` `stream_event` frame emits a
  `text.delta` event carrying that text, in order, before `session.ended`. **Positive control (must
  fail if broken):** remove the `streamPartialText` from the spec in the second test and the
  `text.delta` assertion fails. Cluster gate green. Commit.

## 2. `onDelta` on the run port + the live orchestrator ask (Decisions 1, 2, 3)

- [ ] 2.1 `packages/core/src/handoff-loop.ts`: add `readonly onDelta?: (text: string) => void` to
  `HandoffRunInput`, documented as "each assistant text increment as it arrives; absent ⇒ no streaming
  (the write-handoff path passes none)". `runHandoffTurn` (the checkpoint bracket) is **not** changed
  and never passes it.
- [ ] 2.2 `packages/adapters/src/handoff-run-live.ts`: in the drain loop, call `input.onDelta?.(event.text)`
  on `event.kind === "text.delta"`; and in `createSession`, set `streamPartialText: input.onDelta !== undefined`
  — a caller that supplies a delta sink is asking for deltas, so no second parameter is needed and
  cluster 1's option is consumed exactly where it is wanted. The write-handoff caller passes no
  `onDelta`, so its session spec and behaviour are byte-identical. Add a test: a fake `HarnessPort`
  emitting two `text.delta` events then `session.ended` delivers both, in order, still returns the
  completed `finalText`, and — **positive control** — records `streamPartialText` on the spec only when
  `onDelta` was passed.
- [ ] 2.3 `packages/server/src/review-ask-live.ts`: `buildOrchestratorAskPrompt(review, question, selection?)`
  — a review-grounded prompt carrying the reviewer's question, the repository root, the active
  patchset's branch + base/head oids, and the raw diff bounded through the **existing**
  `truncateToBytes` (introduce `ORCHESTRATOR_ASK_DIFF_CEILING`; the orchestrator has real repository
  tools so it may be tighter than Codex's 40 KB, but it must be a declared constant, not a magic
  number). The prompt instructs: answer the question concretely, read the repository when you need to,
  and do NOT commit or push (prompt instruction, not a withheld capability — Decision 3). Fold
  `selection.anchor` / `selection.excerpt` into the prompt when present.
- [ ] 2.4 `packages/server/src/review-ask-live.ts`: `createLiveOrchestratorAsk(deps)` — the structural
  sibling of `createLiveCodexAsk` in the same file. `deps.resolveRunPort(repoRoot): Promise<HandoffRunPort | null>`
  (injected so this stays hermetically testable with fakes — no Electron, no real `claude`). It builds
  the prompt, calls the port once with `{ cwd: review.repositoryRoot, prompt, onDelta?, signal? }`, and
  maps the outcome:
  - completed with non-empty text ⇒ `{ model: ORCHESTRATOR_ASK_LABEL, answer: finalText.trim() }`
  - completed with empty text ⇒ an honest "the orchestrator returned no answer" line
  - failed ⇒ `The orchestrator could not answer: <reason>` (the port's REAL reason, never a summary)
  - null port ⇒ `No coding harness (claude) is installed, so the orchestrator cannot answer.`

  It never throws — the router awaits it, and a throw would sink a "both" ask (the same contract
  `createLiveCodexAsk`'s catch already honours).
- [ ] 2.5 Tests in `review-ask-live.test.ts` with a fake run port: completed returns the final text
  under `ORCHESTRATOR_ASK_LABEL`; deltas reach `onDelta` in arrival order; a failed outcome surfaces
  the port's real reason; a null port returns the no-harness line; the prompt contains the question and
  the diff and is byte-bounded by the ceiling. **Positive control:** assert the prompt contains a
  distinctive diff hunk — swap the port to ignore its prompt and the assertion still passes, so
  additionally assert the returned answer is the fake port's text and NOT any canned constant. Cluster
  gate green. Commit.

## 3. Bind it — delete the canned string (Decision 6, 7)

- [ ] 3.1 `packages/server/src/review-ask-live.ts`: add `askOrchestrator?` to `LiveReviewAskDeps` (same
  optional-dep shape `askCodex` uses) and replace the canned `askOrchestrator` body in
  `createLiveReviewAskPorts` with a delegation to it, passing through `onDelta` / `selection` /
  `abortController` with the same `...(x ? { x } : {})` conditional-spread style the file already uses.
  An absent dep returns the honest no-harness line — never the Board-rebuild sentence. **Delete the
  stale `canvasOps@2` / "gone with the Board rebuild (B2)" comments in this file's header and body;
  they are the camouflage the issue names.**
- [ ] 3.2 `packages/server/src/create-server.ts`: in the `reviewAsk: createLiveReviewAskPorts({...})`
  block (~`:2444`), add the `askOrchestrator` dep, built from `createLiveOrchestratorAsk` with
  `resolveRunPort: async (repoRoot) => { const adapter = await claudeAdapterForRepo(repoRoot); return adapter ? claudeHandoffRunPort(adapter) : null; }`.
  Streaming needs no extra wiring here: task 2.2 turns `streamPartialText` on whenever an `onDelta` is
  passed, and dispatch already passes one for a streaming ask. Update the block's comment to describe
  what it now does.
- [ ] 3.3 `packages/server/src/create-server.ts`: **delete the dead `agenticPort`** — the field on
  `CodexResolution` (`:492`), all three assignments (`:518`, `:538`, `:560`), and the now-unused
  `CodexAdapter` / `createCodexTurnTransport` / `deriveCodexImplementedEvidence` imports IF nothing else
  consumes them (check first; `transport` and `capabilityEvidence` exist only to build it). If any is
  still used, delete only the field. *This task is droppable if the create-server diff needs to shrink
  for a merge — it changes no behaviour.*
- [ ] 3.4 `packages/server/src/review-ask-live.test.ts`: the existing "unavailable during the Board
  rebuild" assertion must be **deleted because it now fails**. Replace with: the composed ports
  delegate to the injected `askOrchestrator`; orchestrator-only mode never touches Codex (the router
  law, still proven); "both" returns two answers side by side, unmerged. **Positive control: run the
  old assertion once before deleting it and confirm it fails — if it still passes, nothing was wired.**
  Cluster gate green. Commit.

## 4. The chat dock resolves the live review — `send()` stops being a no-op (Decision 5)

- [ ] 4.1 `packages/app-ui/src/chat/chat-data.ts`: in `useChatDock()`, resolve `reviewId` as
  `projection.reviewId ?? <the route's session slug resolution>`, using `useSlugResolution` from
  `../routes/slug` against the `ROUTES.session` / `ROUTES.sessionRun` match (`useRoute` from `wouter`,
  the same pair `layout.tsx` already matches on). Off a session route ⇒ still `undefined` ⇒ the dock
  stays honestly empty; the context override keeps working so the existing dom tests are unchanged.
  **The edit stays inside `chat/` — do NOT touch `routes/layout.tsx` (merge surface).**
- [ ] 4.2 Same file: delete the stale header claims. The "B9-GATED (stubbed) … Protocol carries no
  `session.transcript` read yet" block is **false** — `session.transcript` exists
  (`protocol/src/commands/index.ts:1364`) and is served (`create-server.ts` `transcriptRowsForReview`).
  Rewrite the header to describe what this file actually does now, and correct the
  `SessionTranscriptProjection.reviewId` doc comment ("cluster 7 resolves it from the real route") to
  say it is a test/host override over the live route resolution.
- [ ] 4.3 A dom test mounting `<ChatDock/>` on a real session route with **NO**
  `SessionTranscriptProvider`, asserting typing + send invokes `review.ask` through `MemoryBridge` with
  the route's review id and the typed question (fixtures as `MemoryBridge` only — Track C standing
  law; no component calls `bridge.invoke`). **Positive control: this test must FAIL on `main` today** —
  run it before 4.1 to prove it. Cluster gate green. Commit.

## 5. Chat turns survive a reload

- [ ] 5.1 `packages/app-ui/src/chat/chat-data.ts`: `send()` includes an `anchor` on the `review.ask`
  input — `{ kind: "fragment", label: <the question, bounded>, key: threadId }`, the shape
  `conversationAnchorSchema` already carries for "anchors to a message, not code" (no `path`). Without
  it `dispatch/review.ts:204` skips persistence entirely, so a real answer is lost on reload and
  `review.reattach` — the dock's own read — returns empty. No protocol change; no server change.
- [ ] 5.2 Test: after a completed ask, `review.reattach` for that review returns the thread with the
  reviewer's message and the orchestrator's answer. **Positive control:** drop the anchor and the
  reattach comes back empty. Cluster gate green. Commit.

## 6. E2E, docs, full gate

- [ ] 6.1 An end-to-end test in `packages/server` (sibling of `b11-exits-e2e.test.ts`) driving the real
  `review.ask` dispatch path with a fake harness port: the reviewer's question streams `ask-delta`
  frames, settles with `ask-complete` carrying the final answer, persists, and — with the harness
  resolution returning null — settles with the honest unavailable answer instead. Assert the
  `ask-pending` attention raises and clears, and that a `review.interrupt` mid-turn yields exactly one
  terminal (`ask-interrupted`), so the existing machinery is proven still intact under a live port.
- [ ] 6.2 **Live E2E, driving the real app** (BUILD-LOOP: UI changes are proven by driving the real
  app). Open a review, type a real question in the chat dock, watch tokens stream in, and get a
  grounded answer that references the actual diff. Reload and confirm the exchange is still there.
  **Positive control:** relaunch the daemon with `RENNET_DISABLE_HARNESS=1` and confirm the dock
  reports an honest unavailable answer naming the missing harness — never a plausible-sounding answer,
  never a silent hang. Record the evidence in the commit message; never assert it.
- [ ] 6.3 Docs in the same change (definition of done). `docs/using/guides/getting-started.md:161,172`
  and `docs/using/guides/context-map.md:9,47` already describe asking the orchestrator — they were
  *wrong* against the code and are now right, so verify each claim against the shipped behaviour.
  **Two sentences overstate even after this change** and must be corrected unless cluster 7 lands:
  `getting-started.md:172-174` ("tell it what you have concluded, and it **stages the result** and
  narrates the receipt in the transcript") and `reviewing-a-github-pr.md:89` ("conclude something in
  chat and the orchestrator **stages** …"). Chat answers; it does not yet act on the app (proposal,
  Out of scope). Check `docs/` for any other page describing the chat dock as pending.
- [ ] 6.4 `sh -c 'pnpm check'` green, with a positive control capable of failing. Output
  `<promise>F1-COMPLETE</promise>`. Commit.

---

## 7. OPTIONAL — `app_*` tools: let the orchestrator act on the app (#465, `buildAppTools`)

**Droppable. Not a release blocker.** Clusters 1–6 make the dock answer honestly; this makes it *act*.
Dropping it makes no surface lie. It is a real build, not wiring — schedule it or file it, but do not
half-land it. If dropped, open a follow-up issue quoting this cluster verbatim.

- [ ] 7.1 `packages/core/src/harness.ts`: `SessionSpec.inProcessTools?: readonly InProcessTool[]`, where
  `InProcessTool` is `{ name, description, inputSchema: unknown, run(input): Promise<unknown> }` — a
  node-free, SDK-free descriptor (core may not import the SDK). This is deliberately the shape
  `AppTool` (`server/src/agent-tools.ts:27`) already has.
- [ ] 7.2 `packages/adapters/src/claude-query.ts` + `claude-adapter.ts`: map the descriptors onto the
  SDK's `createSdkMcpServer({ name: "rennet", tools: [tool(...)] })` and set `sdkOptions.mcpServers`.
  ⚠️ **The known hazard:** the installed `claude` CLI's ajv rejects Zod v4's draft-2020-12 output —
  `normalizeOutputSchema` in this file exists for exactly that reason. Tool input schemas go through
  the same normalization or they will be rejected at turn start. Append `mcp__rennet__*` to the session's
  allowed tools (`claude-adapter.ts:49` `SESSION_ALLOWED_TOOLS`) or the model will never be able to call
  them.
- [ ] 7.3 `packages/server/src/create-server.ts`: pass `buildAppTools(dispatch)` into the ask's session
  spec. ⚠️ `dispatch` is constructed **from** the deps object the ask port lives in — late-bind it the
  way `wsListener` already is (a `let` assigned below, read only when a turn starts), never a second
  dispatch instance.
- [ ] 7.4 **Live proof, not a unit test:** ask the orchestrator in the real chat dock to perform a real
  registry-exposed command and confirm the app state actually changed. **Positive control:** flip a
  command's `exposure.agent` to false in the registry and confirm its tool disappears from the turn —
  proving the surface is the pure projection `agent-tools.ts` claims and not a hand-maintained list.
  Full gate green. Commit.
