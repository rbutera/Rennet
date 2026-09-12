# The session thread is briefed — the orchestrator knows it is Rennet's

## Why

A reviewer asked the chat, on 2026-09-12, what it knew about being Rennet's orchestrator. It
answered, correctly, that it knew nothing: a plain Claude Code agent with the generic harness
prompt, the reviewed repository's own `CLAUDE.md`, and no word from Rennet. That is exactly what
the code does. The session's thread is created in `packages/server/src/t3/threads.ts:430` with a
project id, a title, a model selection and a worktree path, and nothing else; a send is the
composer's raw text (`dispatch/chat.ts:124`); the vendored T3 Claude adapter runs the stock
`claude_code` preset system prompt (`ClaudeAdapter.ts:4523`). Rennet never speaks.

This is not a bug in the T3 move. It is a deletion that took the briefing with it and nobody
re-homed it. The original orchestrator (`build-orchestrator-session`, 2026-08-11) woke up on a
≤4 KB primer: review identity, board state as counts, a protocol card teaching what it could do
and how to ask, a tool index. F1 (2026-09-01) collapsed that into a per-ask prompt naming the
branch, the base and head, and the rule to read the repository and not commit or push. Then
`t3-lens-threads` (2026-09-03) deleted the orchestrator session and the primer under R51, with
its own risk table saying: *"the primer's map pointer is replaced by the checkout itself."* The
checkout carries the code. It does not carry the review — which patchset, what the boards
concluded, what is flagged, what asks are staged, what rounds ran, what the reviewer's Explain
just cited. The seats got a briefing pattern when they moved to threads (a first-turn prompt, a
context directory, a board MCP server). The session thread got nothing.

Six gaps, in the order they hurt:

1. **No identity or division of labour.** The thread does not know Rennet exists, that lens seats
   already read the change, or that coding rounds run on their own threads. It has full write
   access in the worktree and no instruction about when to write. F1's "read, answer, do not
   commit or push" is gone.
2. **No review context, though it is all reachable.** The patchset's base and head, the boards
   (readable through `board.read`), and `.rennet/context/<sessionId>/README.md` — the indexed,
   progressive-disclosure map the seats are pointed at (`lens-pipeline.ts:775`) — are never named
   to the thread.
3. **Explain sends an opaque reference.** `anchored-ask.tsx` sends the question, up to 600 chars
   of excerpt, and `Code reference: {json}`. The model has no idea what a `CodeRef` is or which
   board and lens the span came from.
4. **Staging is designed, built, and unwired.** `AGENT_EXPOSED` names 13 commands including
   `ask.stage`, `review.capture` and `review.openPr`; `buildAppTools` projects them;
   `createThread` accepts `mcpServers` and the seats use it. No server stands up the app tools
   and the session thread passes none. #620 closed as completed on 2026-08-29; its wiring was
   deleted with `review.ask` and no open issue tracks the loss. `getting-started.md:437` now says
   *"Nothing the thread says stages anything"*, while `CONTEXT.md` still defines an Ask as
   *"staged by the orchestrator"* and App tools as *"commands exposed to the orchestrator"*.
5. **The model is hard-wired.** `bindReviewThread` passes no model selection, so the session
   thread falls to `DEFAULT_MODEL` in `supervisor.ts:105`. The council carries an
   `orchestrator-chat` job (`model-council.ts:197`) with a pick per profile and the welcome writes
   an `orchestrator` review role; neither reaches the thread.
6. **No voice guidance.** Seats carry `reader-voice.md`; the chat carries nothing, and the old
   card's "never answer about the base branch from recall — retrieve first" went with it.

Rai's ruling, 2026-09-12: the thread stages asks; *"the doc sentence is the thing that changes."*
Rule Zero: a capable agent is the product, and every tool this needs is already built.

## What Changes

- **A thread carries its briefing and its tools.** The vendored `thread.create` command gains an
  optional `instructions` (a system-prompt append) and an optional `mcpServers` (the same
  `name → { url, bearerTokenEnvVar? }` shape the turn already carries). Both live on the THREAD
  record, are read when the provider session starts and again on recovery, and apply to every
  turn on that thread — including the ones T3's own composer starts, which Rennet does not author.
  The Claude adapter passes `instructions` as `systemPrompt: { preset: "claude_code", append }`;
  the Codex adapter appends it to the developer instructions it already assembles. One ledger row
  per file, upstreamable, the same shape as the `outputSchema` / `mcpServers` rows.
- **The session briefing** is a new prompt file in `@rennet/prompts`, rendered by a pure function
  with a declared byte ceiling (`SESSION_BRIEFING_MAX_BYTES`, 4,096 — the original primer's
  bound). It is a MAP: role and division of labour; the patchset (branch or PR, base and head, the
  exact `git diff` command); where the boards are read (`board_read`) and what the context
  directory is; what the app tools do and why staging an ask — to the draft PR or the round
  submission — is the path Rennet tracks; what an Explain's `Code reference` is; its own short
  register, no shared partial (Rai, 2026-09-12: `reader-voice.md` is 2,847 B against a 4,096-byte
  ceiling, and it is written for board prose). It carries no board, no diff,
  no inventory — session-context-files' "no prompt carries context inline" holds for the append
  exactly as for a prompt, and harder: an append is a prefix re-billed on every turn.
- **The app-tools MCP server.** The daemon stands up one loopback HTTP MCP listener for
  `buildAppTools(dispatch)`, mirroring `board-mcp-server.ts` (address, process bearer in the
  sidecar's environment, hand-rolled Streamable HTTP), under its own name `rennet_app`. It is
  passed on the session thread at bind. The read commands the thread needs to know what the
  reviewer is talking about join `AGENT_EXPOSED`: `board.read`, `session.list`, `review.load`,
  `patchset.readEvidence`, `patchset.readSpan`, `ask.read`, `session.rounds`, `session.transcript`,
  `review.deltaDigest`, `review.symbolLookup`; and the acts it is steered toward: `ask.unstage`,
  `ask.edit`, `ask.quoteReply`, `review.handoff.compose`, `review.draftPrBody`, `round.dispatch`.
  The boards on disk are event logs, not a thing to point a model at.
- **The session thread routes through the council.** `bindReviewThread` resolves the
  `orchestrator-chat` job the way `resolveBoardSeatDetails` resolves a seat, and passes the
  resulting model selection. `DEFAULT_MODEL` stays only as the fallback when the council has no
  installed provider for the job.
- **Explain names its anchor.** `anchoredAskText` labels the reference for what it is (the board,
  the lens, the path and lines) rather than a bare JSON blob, still within its existing bounds.
- **Docs and glossary.** `getting-started.md:437` says the thread can stage an ask and that the
  reviewer sends it. `CONTEXT.md`'s Ask, App tools and Orchestrator harness entries are made true
  against this change. `t3code-sidecar.md` gains the briefing and app-tools sections;
  `t3code-vendoring.md`'s ledger prose names the new rows. `docs/developing/concepts/model-council.md`
  names the job the chat runs on.

## Out of scope — with the reason

- **A context-update stream** (the old `{selected}/{disposed}/{viewing}` push). The thread reads
  state through tools when asked; pushing acts into the prefix is the inline-context failure mode
  in a new coat. If deixis proves necessary, it is a tool the thread calls (`app_review_selection`),
  not a stream.
- **Re-adding a second-opinion mode.** R51 retired it; one model answers.
- **Approvals, permission modes, or any "the thread must ask before it stages".** Rule Zero. The
  ask lands in the reviewer's composer and goes out through the exits as every ask does.
- **Tool and thinking activity in Rennet's own UI.** T3's view already renders them.

## Decisions (part of the spec — hold these, do not re-open)

1. **Briefing and tools live on the thread, not the turn.** The session's turns are started by T3's
   composer, which Rennet does not author, and a provider session is built on the FIRST turn and
   "a turn that asks for nothing rides whatever the session holds" (`ClaudeAdapter.ts:4766`). A
   per-turn field would brief only the turns Rennet sends — the Explain and the handoff — and leave
   the reviewer's own typed questions bare. Rejected alternative: Rennet sends a first turn at
   bind carrying both. That is a billed model turn at capture whose reply lands in the reviewer's
   transcript as a machine message; no.
2. **The briefing is a map under 4,096 bytes and names paths and tools, never content.** Same rule
   as every prompt (`session-context-files`), and the reason is sharper here: a system-prompt
   append is a prefix, re-read on every round trip of every turn for the life of the thread.
3. **The thread can do everything the reviewer can, and the briefing forbids nothing.** Full
   access, Bash included, the app tools, the read commands. It is STEERED toward staging asks —
   to the draft PR or the round submission — because that is the mechanism Rennet tracks and
   receipts; it is not hamstrung. The briefing carries no "never", no "do not commit", no "do not
   push": any rule of that shape is bad and goes (Rai, 2026-09-12). F1's "do not commit or push"
   line is NOT carried forward.
4. **App tools are a projection of `AGENT_EXPOSED`, never a hand list.** Adding a row is a flag
   flip in `protocol/commands`; the MCP server iterates `buildAppTools`. The set is decided per
   row for the thread's job — knowing what the reviewer is looking at and acting through the
   tracked paths — and any row a reviewer can reach from the app is a candidate. The positive control
   from F1 cluster 7.4 applies: flip a row off and its tool must vanish from the thread.
5. **The model comes from the council's `orchestrator-chat` job.** The job exists, has picks per
   profile, and is consumed nowhere. Wire it; do not invent a second setting.
6. **Codex gets the same briefing.** T3 already assembles developer instructions for Codex
   (`CodexDeveloperInstructions.ts`); the append goes there. A thread on either provider is briefed
   or the surface lies by provider.

## Verification (positive controls that can fail)

- **Ledger:** a vendored contract test decodes `thread.create` with and without the two fields; the
  Claude adapter test asserts `systemPrompt.append` is set from the thread's instructions and absent
  without them (control: drop the pass-through, the assertion reddens); the Codex adapter test
  asserts the developer instructions carry the append.
- **Briefing:** `session-briefing.test.ts` renders against a fixture and asserts the byte ceiling, the
  presence of the patchset line and the attached-tool count, and the ABSENCE of any diff hunk or board
  element (control: interpolate one board element and the absence assertion fails). The manifest
  test in `@rennet/prompts` covers the new file and asserts it carries no partial marker.
- **App tools server:** a hermetic test drives `tools/list` and asserts the set equals
  `buildAppTools`' names; flips `board.read` out of `AGENT_EXPOSED` in a fixture registry and
  asserts it vanishes; calls `app_ask_stage` and asserts the ask reaches the dispatch with the
  thread's identity as author.
- **Bind:** `threads.test.ts` asserts a session bind passes `instructions`, `mcpServers` and the
  council's selection to `createThread`, and that a seat bind passes neither instruction nor the
  app server (seats keep their own briefing path).
- **Live, driving the real app** (BUILD-LOOP): open a review, ask the thread what it is and what it
  can do — it names Rennet, the branch, the boards and the tools. Ask it to stage an ask for a
  flagged finding — the ask appears in the composer with the thread as author, where the exits
  take it. Ask it which finding you mean by naming a lens and a file — it reads the board and
  answers. Ask an Explain from a board span — the answer names the lens and lines. Reload; the thread's
  next turn still has the briefing (recovery). Evidence in the PR, never asserted.
- The PR description states the prompt-size delta: bytes of the append, and that it is per-turn
  prefix cost for the life of the thread (AGENTS.md, harness prompts & token discipline).
- `pnpm check` green.

## Completion sigil

`<promise>SESSION-THREAD-BRIEFING-COMPLETE</promise>`
