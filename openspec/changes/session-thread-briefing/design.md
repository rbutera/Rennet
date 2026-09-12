## Context

Verified against `main` at 807bcfeb (2026-09-12):

- The session's thread is bound in `dispatch/chat.ts` `bindReviewThread` → `sidecar.threadFor` →
  `threads.ts` `findOrCreateBinding` → `client.createThread({ projectId, title, modelSelection,
  worktreePath, branch })`. `modelSelection` is absent on a session bind and falls to
  `supervisor.ts` `DEFAULT_MODEL`. Seats bind through the same `threadFor` with a council-routed
  selection and receive a per-turn `boardServer` address (`seat-address.ts`).
- Every turn on the session thread is started by one of two callers: T3's own composer (the
  reviewer typing) and `chat.t3Send` (Explain, `anchored-ask.tsx`). The handoff and each round run
  on their own threads (`t3/handoff.ts`, `round-worker-thread`).
- The vendored Claude adapter builds its `query()` options once per provider session
  (`ClaudeAdapter.ts:4520-4545`): `systemPrompt: { type: "preset", preset: "claude_code" }`,
  `settingSources: ["user","project","local"]`, `mcpServers` merged from the turn's caller set and
  T3's own. The SDK fixes `systemPrompt`, `outputFormat` and `mcpServers` at construction. A later
  turn asking for nothing "rides whatever the session holds" (`:4766`); a later turn asking for a
  DIFFERENT set is refused by name. Recovery from a persisted resume cursor re-reads the persisted
  turn's `outputSchema` and `mcpServers` (ledger row on `ProviderService.ts`).
- The SDK's option is `systemPrompt: { type: 'preset', preset: 'claude_code', append?: string }`
  (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`). T3's Codex leg assembles developer instructions in
  `provider/CodexDeveloperInstructions.ts` and already appends a conditional browser block.
- `thread.create` (`contracts/src/orchestration.ts:739`) carries `modelSelection`, `runtimeMode`,
  `interactionMode`, `branch`, `worktreePath`. The thread record is what a session start reads its
  model from.
- `board-mcp-server.ts` is the daemon's loopback Streamable-HTTP MCP listener: one address per
  seat, a process bearer in the sidecar's environment (`BOARD_BEARER_ENV_VAR`), `tools/list` and
  `tools/call` over `application/json`. `agent-tools.ts` `buildAppTools(dispatch)` projects the
  13 rows of `AGENT_EXPOSED` into `{ name, inputSchema, run }` descriptors.
- Boards persist under `.rennet/boards/<board>/log.jsonl` as event logs (`file-board-store.ts`);
  the readable projection is the `board.read` command. `.rennet/context/<sessionId>/` is written
  at generation start with a `README.md` index; a chat-only session has none yet.
- The council's `orchestrator-chat` job (`model-council.ts:197`, picks at `:372/:419/:462`) is
  consumed nowhere. `resolveAssignment` (`:634`) is how a job becomes a provider + model.
- `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` is 120,000; the append is not turn input and is not
  counted against it.

## Goals / Non-Goals

**Goals**

- Every turn on a session thread, whoever starts it, runs with Rennet's briefing and Rennet's tools.
- The briefing is a bounded map that survives daemon restart and provider-session recovery.
- The thread can read a board and stage an ask; the reviewer sends it.
- The thread runs on the council's routing for the job that already names it.
- The docs and the glossary describe this and only this.

**Non-Goals**

- Pushing reviewer acts into the thread (a stream). Tools pull.
- A per-turn `instructions` field. Rennet-started turns are a minority of the thread's turns.
- Any change to the seats' briefing path, `SESSION_ALLOWED_TOOLS`, or the ephemeral utility
  turns.
- Sending the vendored patches upstream in this change (they are marked upstreamable; group 4
  of `t3code-sidecar-chat` still owns the send).

## Decisions

**Thread-level `instructions` and `mcpServers`, read at session start and on recovery.**
`thread.create` (both command shapes and the `thread.created` event) gains
`instructions: Schema.optionalKey(TrimmedString)` and `mcpServers: Schema.optionalKey(TurnMcpServers)`,
persisted on the thread record and projected onto `OrchestrationThread`. `ProviderCommandReactor`
reads them off the thread when it builds `ProviderSessionStartInput`; `ProviderService`'s recovery
path reads them off the thread as it already reads the persisted turn's schema and servers. Merge
rule for `mcpServers`: the thread's set is the session's base; a turn's set is checked against
(thread ∪ turn) with the existing `differingTurnMcpServerNames`, so a seat-style per-turn address
still works on a briefed thread and a composer turn (no set) rides the thread's. Name collisions
follow the existing rule: `t3-code` is T3's, refused by name.

*Alternative rejected: per-turn field only.* Briefs the two turns Rennet starts, not the reviewer's.
*Alternative rejected: Rennet sends a first turn at bind.* A billed turn with a machine reply in
the reviewer's transcript, and it races the reviewer's own first message (`review.capture` binds
ahead of the dock, #849, but the dock is open at arrival).
*Alternative rejected: a `RENNET.md` the harness reads as project instructions.* Claude reads
`CLAUDE.md` from the checkout, which is the USER's file; writing into it is out (Rennet never
stages `.rennet/`, and `CLAUDE.md` is not even under it). Codex reads `AGENTS.md`, same objection.

**Claude: `systemPrompt.append`. Codex: developer-instructions append.** In `ClaudeAdapter.ts` the
preset object gains `append: instructions` when the thread has one; nothing else in the option set
changes, so the user's own settings, MCP servers and `CLAUDE.md` still inherit (Rai's 2026-09-01
ruling on `settingSources`). In `CodexDeveloperInstructions.ts` the assembled string gains the
append after T3's own blocks. Both adapters record the instructions on the session context and
refuse a later turn... no — there is no per-turn field, so there is nothing to compare. A thread's
instructions are fixed at create, exactly like its worktree.

**The briefing is a prompt file plus a pure renderer.** `packages/prompts/src/prompts/session-briefing.md`
carries the fixed text: role (the review's conversation inside Rennet; five lens boards drafted by
seats that already read the change; rounds on their own threads; the reviewer judges and clicks
the exits), what it can do (everything the reviewer can: read, run, edit, and use the app through
its tools), the steer (stage asks to the draft PR or the round submission, because that is the
path Rennet tracks and receipts — a steer, never a prohibition; the file carries no "never"),
what an Explain's `Code reference` is, how to find and read a review (`app_session_list`,
`app_review_load`, `app_board_read`, `app_patchset_readSpan`), and its own short register — no
shared partial, because `reader-voice.md` is 2,847 B of board-prose guidance against a 4,096-byte
ceiling that must also hold the review's lines, and its ground rules tell a writer not to name
lenses or boards, which is the opposite of what this thread does for the reviewer (Rai,
2026-09-12). `renderSessionBriefing(input)` in `prompt-contracts.ts` splices the dynamic lines — the
patchset (branch or PR number, base and head oids, the exact `git diff <base>...<head>` command),
the context directory path when one exists, the tool names actually attached — and enforces
`SESSION_BRIEFING_MAX_BYTES = 4096` with an honest truncation marker on the dynamic lines only
(the fixed text is sized to fit with room; the manifest test pins it). Every interpolation names
its bound at the call site. The renderer is node-free; the daemon resolves the file.

**The app-tools server mirrors the board server, under `rennet_app`.** `packages/server/src/app/app-mcp-server.ts`
(new) stands up one loopback Streamable-HTTP listener at daemon start — eager, like the sidecar
(#849) — serving `tools/list` from `buildAppTools(dispatch)` (input schemas through
`normalizeOutputSchema`, the same ajv hazard as the board server) and `tools/call` by dispatching.
Authentication is the process bearer in the sidecar's environment, under `RENNET_APP_BEARER`,
named on the thread's `mcpServers` entry as `bearerTokenEnvVar`; there is no per-thread token
because the thread's identity rides the address path (`/threads/<threadId>`), which is what
`ask.stage` uses to stamp the author (`{ kind: "orchestrator" }` — the author kind
`protocol/board/schema.ts:49` already carries) and the session. `dispatch` is late-bound the way
`wsListener` is. The listener's port is remembered in the sidecar's base dir, like the board
server's, so a restarted daemon comes back on the url a live session was created with — the url
is fixed on the thread and a different one would be refused.

**The read and act rows join `AGENT_EXPOSED`.** Lines in `protocol/commands/index.ts`, one per
row, each with its rationale in `command-menu-exposure.md`: reads — `board.read`, `session.list`,
`review.load`, `patchset.readEvidence`, `patchset.readSpan`, `ask.read`, `session.rounds`,
`session.transcript`, `review.deltaDigest`, `review.symbolLookup`; acts — `ask.unstage`, `ask.edit`,
`ask.quoteReply`, `review.handoff.compose`, `review.draftPrBody`, `round.dispatch`. Every result
that carries a collection declares a cap with an honest marker and a cursor:
`BOARD_READ_TOOL_ELEMENT_CAP` (200), `SESSION_LIST_TOOL_CAP` (50), `TRANSCRIPT_TOOL_ROW_CAP` (100),
`EVIDENCE_TOOL_BYTES_CAP` (16 kB). Rows in `board-tool-surface.measure.test.ts` pin each per-call
ceiling.

**The council routes the session thread.** `bindReviewThread` resolves `orchestrator-chat` through
the same seam `resolveBoardSeatDetails` uses (provider + model + effort → `modelSelection(...)`),
and passes it. When the council has no installed provider for the job, the bind falls to
`DEFAULT_MODEL` and says so in the daemon log — the thread still opens. The welcome's
`orchestrator` review role is the council input it already writes; nothing new is stored.

**Explain labels its anchor.** `anchoredAskText` renders one line naming the board target, the
lens, the path and the line range, and then `Code reference:` with the JSON as today. The JSON is
a `CodeRef` (`protocol/delta/citations.ts`: `patchsetId`, `path`, `side`, `startLine`, `endLine`,
optional `symbol`) — it carries no board and no lens, which is why the labelled line above it
does. `ask.stage` takes a `StagedAsk` (`protocol/session/ask-log.ts`) whose `anchor` is a required
string and whose `codeRef` is the optional canonical position, so the briefing tells the thread to
pass that JSON as the ask's `codeRef` beside its own `anchor` and body. Bounds unchanged.

**Doc and glossary edits, in this change.** `getting-started.md:437` becomes: the thread can use
Rennet as you do — read the boards, stage asks into your composer, compose a handoff, dispatch a
round — and staging is where it is steered, because a staged ask is what Rennet tracks.
`CONTEXT.md` Ask: "Staged by the reviewer or by the session thread; the receipt is the undo."
App tools: "the commands exposed to the session thread as tools; the set is decided per row". Orchestrator harness: "the
council's `orchestrator-chat` routing; chosen in the welcome". `t3code-sidecar.md` gains "The
session thread's briefing" and "The app-tools server" sections beside "Seats as threads";
`t3code-vendoring.md` names the new ledger rows; `model-council.md` names the job.

## Risks / Trade-offs

- [The append is a prefix on every turn for the thread's life] → 4,096-byte ceiling, fixed text
  measured in the manifest test, dynamic lines bounded and truncated honestly; PR states the bytes.
- [A fold changes `thread.create` or the adapters' option assembly] → ledger rows, `t3:check-ledger`,
  and the boot contract probe naming the method; the append is one object field, not a new path.
- [The thread stages an ask the reviewer did not want] → the receipt is the undo (existing). This
  is a feature, not a risk to gate.
- [The thread edits the branch directly instead of staging] → that is allowed; the steer in the
  briefing is the whole answer, and a direct edit shows in the review's freshness watch like any
  other edit.
- [The app server's port changes across daemon restarts] → remembered in the base dir like the
  board server's; a thread created against a dead url fails its next turn with the adapter's
  own "different settings" message, which the dock already renders as a reported state (#872).
- [Codex threads have no `systemPrompt`] → developer instructions are Codex's equivalent and T3
  already writes them; tested on both legs.

## Migration Plan

Additive. Existing session threads were created without instructions or servers and stay that way
for their life; the thread list reads sensibly because their titles do not change. A reviewer who
wants a briefed thread on an old session archives and reopens it (un-archiving creates a fresh
thread, `t3-lens-threads`). No setting, no flag, no fallback engine.
