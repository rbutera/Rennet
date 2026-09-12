# Tasks — session-thread-briefing

Read `proposal.md` (its **Decisions** are part of the spec) and `design.md`. One cluster per
session; the gate is green after every cluster; one commit per checked task. Cluster gate
`sh -c 'pnpm nx affected -t lint,typecheck,test'`; full `sh -c 'pnpm check'` at cluster 6.
Every edit to a vendored file gets its `vendor/t3code/PATCHES.md` row in the same commit.

**Session-start bearings (each must hold, or re-scope before writing code):**

```sh
sed -n '425,436p' packages/server/src/t3/threads.ts            # createThread: no instructions, no mcpServers
grep -n "modelSelection" packages/server/src/dispatch/chat.ts    # expect: NO hits (session bind passes none)
grep -rn "orchestrator-chat" packages/server/src                 # expect: NO hits (job unconsumed)
grep -n "systemPrompt" vendor/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts  # one preset line, no append
grep -n "board.read" packages/protocol/src/commands/index.ts     # present; NOT in AGENT_EXPOSED
```

---

## 1. Vendored seam — a thread carries `instructions` and `mcpServers`

- [ ] 1.1 `vendor/t3code/packages/contracts/src/orchestration.ts`: `thread.create` (both command
  shapes) and the `thread.created` event gain optional `instructions` (TrimmedString) and
  `mcpServers` (`TurnMcpServers`); the thread projection carries both. Contract test: decodes with
  and without; a raw credential still has nowhere to live. Ledger row.
- [ ] 1.2 `apps/server/src/orchestration/decider.ts` + `Layers/ProviderCommandReactor.ts`: persist
  both on the thread; when a provider session starts for a thread, `ProviderSessionStartInput`
  carries the thread's `instructions` and the union of the thread's and the turn's `mcpServers`.
  `ProviderService.ts` recovery reads the thread's pair the way it reads the persisted turn's
  schema and servers. Test: a stale session recovered for a briefed thread starts with the
  briefing and the thread's servers. Ledger rows.
- [ ] 1.3 `Layers/ClaudeAdapter.ts`: `systemPrompt: { type: "preset", preset: "claude_code", ...(instructions ? { append: instructions } : {}) }`.
  Nothing else in the option set changes. Test: append set from the thread, absent without;
  **positive control** — remove the spread and the assertion reddens. The turn-vs-session MCP
  comparison uses (thread ∪ turn). Ledger row.
- [ ] 1.4 `Layers/CodexAdapter.ts` + `provider/CodexDeveloperInstructions.ts`: the thread's
  instructions are appended after T3's own blocks. Test on the scripted app-server: the
  developer instructions carry the append. Ledger rows.
- [ ] 1.5 `packages/server/src/t3/client.ts`: `CreateThreadInput` gains `instructions?` and
  `mcpServers?`; `createThread` passes both. Boot contract probe unchanged (no new method).
  Cluster gate green. Commit.

## 2. The briefing — `@rennet/prompts`

- [x] 2.1 `packages/prompts/src/prompts/session-briefing.md`: the fixed text per design (role,
  what it can do — everything — and the steer toward staging, Explain's `Code reference`, finding
  and reading a review, and its own short register — no shared partial, because splicing
  `reader-voice.md` (2,846 B) under the 4,096-byte ceiling leaves no room for the review's lines
  and its ground rules tell a writer not to name lenses or boards). A test asserts the file
  contains no "never", "do not commit", "do not push" or "must not" sentence (**positive
  control:** add one, it reddens). Exported as `SESSION_BRIEFING_FILE`; the manifest test covers
  the file and asserts it carries no partial marker at all.
- [x] 2.2 `prompt-contracts.ts`: `renderSessionBriefing(input: SessionBriefingInput): string` —
  splices patchset (kind, branch or PR number, base and head oids, the exact `git diff` command),
  the context directory path when present, and the attached tool names; `SESSION_BRIEFING_MAX_BYTES = 4096`
  enforced with an honest marker on the dynamic lines; every interpolation bounded at its call site.
- [x] 2.3 `session-briefing.test.ts`: byte ceiling; patchset line and tool names present; a fixture
  with a 95-file change renders byte-identical to a 1-file change (no content travels); **positive
  control** — interpolate one board element into the fixture and the absence assertion fails.
  Cluster gate green. Commit.

## 3. The app-tools server — `rennet_app`

- [ ] 3.1 `packages/protocol/src/commands/index.ts`: the read and act rows named in design join
  `AGENT_EXPOSED` (`board.read`, `session.list`, `review.load`, `patchset.readEvidence`,
  `patchset.readSpan`, `ask.read`, `session.rounds`, `session.transcript`, `review.deltaDigest`,
  `review.symbolLookup`, `ask.unstage`, `ask.edit`, `ask.quoteReply`, `review.handoff.compose`,
  `review.draftPrBody`, `round.dispatch`); the exposure doc table gains each row with its
  rationale.
- [ ] 3.2 `packages/server/src/app/app-credentials.ts` (leaf, like `board-credentials.ts`):
  `APP_MCP_SERVER_NAME = "rennet_app"`, `APP_BEARER_ENV_VAR = "RENNET_APP_BEARER"`; `t3/sidecar.ts`
  places the bearer in the sidecar's environment beside the board bearer.
- [ ] 3.3 `packages/server/src/app/app-mcp-server.ts`: loopback Streamable-HTTP listener serving
  `tools/list` from `buildAppTools(dispatch)` (schemas through `normalizeOutputSchema`) and
  `tools/call` by dispatch, thread identity from the address path, port remembered in the sidecar
  base dir. Every collection-carrying result capped per design (`BOARD_READ_TOOL_ELEMENT_CAP`,
  `SESSION_LIST_TOOL_CAP`, `TRANSCRIPT_TOOL_ROW_CAP`, `EVIDENCE_TOOL_BYTES_CAP`) with an honest
  marker and a cursor; a row per cap in `board-tool-surface.measure.test.ts`. `dispatch` late-bound.
- [ ] 3.4 Tests: `tools/list` equals `buildAppTools`' names; **positive control** — a fixture
  registry with `board.read` flipped off loses the tool; `app_ask_stage` reaches dispatch with
  `author.kind === "orchestrator"` and the session id; a call without the bearer is refused.
  `create-server.ts` starts the listener at daemon launch (eager, #849). Cluster gate green. Commit.

## 4. Bind — briefing, tools, and the council on the session thread

- [ ] 4.1 `packages/server/src/dispatch/chat.ts` `bindReviewThread`: resolve the patchset facts and
  the context directory for the review, render the briefing, and pass `instructions`, the
  `rennet_app` server entry, and the council's `orchestrator-chat` selection (through the seam
  `resolveBoardSeatDetails` uses; `DEFAULT_MODEL` only when no installed provider answers, logged).
- [ ] 4.2 `threads.test.ts` / `chat.test.ts`: a session bind passes all three to `createThread`;
  a seat bind passes no instructions and no app server; the council-less case falls to the default
  and logs. **Positive control:** drop the `instructions` pass-through and the bind assertion
  reddens.
- [ ] 4.3 `packages/app-ui/src/review/anchored-ask.tsx`: `Code reference:` is preceded by one
  labelled line (board, lens, path, lines) from the `CodeRef`; bounds unchanged; test updated.
  Cluster gate green. Commit.

## 5. Docs and glossary (definition of done)

- [ ] 5.1 `docs/using/guides/getting-started.md:437`: the thread can use Rennet as you do and is
  steered toward staging asks, which is what Rennet tracks. Line 17's "choose the orchestrator"
  now true: say what it routes.
- [ ] 5.2 `CONTEXT.md`: Ask, App tools, Orchestrator harness entries corrected per design.
- [ ] 5.3 `docs/developing/concepts/t3code-sidecar.md`: "The session thread's briefing" and "The
  app-tools server" sections; `t3code-vendoring.md` names the new ledger rows;
  `docs/developing/concepts/model-council.md` names `orchestrator-chat` as the chat's job;
  `docs/developing/reference/command-menu-exposure.md` gains `board.read`'s agent row.
- [ ] 5.4 `docs/` sweep for any page still saying the chat cannot act or is a plain harness thread.
  Commit.

## 6. Live proof, full gate

- [ ] 6.1 **Driving the real app.** Open a review; ask the thread what it is and what it can do —
  it names Rennet, the branch, the boards and the tools. Ask it to stage an ask for a flagged
  finding — the ask appears in the composer with the thread as author. Ask about a board on
  another session by name — it lists sessions, loads it, reads the board. Explain a board span —
  the answer names the lens and lines. Quit and relaunch the daemon; the thread's next
  turn is still briefed. **Positive control:** flip `board.read` out of `AGENT_EXPOSED`, rebuild,
  and the thread reports it has no board tool. Evidence in the PR body, never asserted; read the PR
  body back after `create`.
- [ ] 6.2 PR description states the append's byte size and that it is per-turn prefix cost for the
  thread's life; states the `app_board_read` per-call ceiling.
- [ ] 6.3 `sh -c 'pnpm check'` green with a positive control capable of failing. Output
  `<promise>SESSION-THREAD-BRIEFING-COMPLETE</promise>`. Commit.
