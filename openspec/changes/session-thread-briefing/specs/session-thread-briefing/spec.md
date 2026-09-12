## Purpose

The session's thread knows it is Rennet's: every turn on it, whoever starts it, runs with a bounded briefing naming the review and with Rennet's app tools attached, so the reviewer's conversation can explain the change against the boards and stage an ask the reviewer then sends.

## ADDED Requirements

### Requirement: A session thread carries its briefing for its whole life

When a session's thread is created, it SHALL carry Rennet's session briefing as an instruction the provider appends to its system prompt, and every turn on that thread — one started by the reviewer's composer, an anchored Explain, or the daemon — SHALL run under it. The briefing SHALL survive a daemon restart and a recovered provider session. The briefing SHALL be a map: it names the review (branch or pull request, base and head, the exact diff command), where the boards are read, the context directory when one exists, how many tools are attached and on which server, what an Explain's code reference is, and the division of labour; it SHALL NOT carry a diff, a board, an inventory or any other content. It SHALL be bounded at a declared byte ceiling, and its rendered size SHALL NOT grow with the change.

#### Scenario: The reviewer's own first message is briefed
- **WHEN** a reviewer types the first message on a freshly bound session thread
- **THEN** the turn runs with the briefing appended and the answer can name the branch and the boards

#### Scenario: A recovered session is still briefed
- **WHEN** the daemon restarts while a session thread exists and the reviewer sends another message
- **THEN** the provider session recovered for that turn carries the same briefing

#### Scenario: A large change renders the same briefing
- **WHEN** the briefing is rendered for a one-file change and for a ninety-five-file change
- **THEN** the two renderings are byte-identical apart from the patchset identity line

### Requirement: The session thread has Rennet's app tools

A session thread SHALL be created with Rennet's app-tools MCP server attached, exposing exactly the commands the registry marks agent-exposed: the reads it needs to know what the reviewer is looking at (sessions, the review, its boards, its patchset evidence, its asks, its rounds, its transcript) and the acts through the paths Rennet tracks (staging, editing and unstaging an ask, replying on a thread, composing a handoff, drafting the PR body, dispatching a round). The tool set SHALL be a projection of that flag and never a hand-maintained list. An ask the thread stages SHALL appear in the reviewer's composer with the thread as its author; staging does not send. The briefing SHALL steer the thread toward staging asks — to the draft pull request or the round submission — as the mechanism Rennet tracks, and SHALL NOT forbid the thread any capability the harness has. A tool result that carries a collection SHALL declare a cap and an honest truncation marker.

#### Scenario: The thread stages an ask
- **WHEN** the reviewer asks the thread to raise a flagged finding as a change request
- **THEN** an ask with the thread as author is staged in the composer, where the exits take it

#### Scenario: The thread knows which review is meant
- **WHEN** the reviewer asks about "the Decisions board on the auth branch" from a session on another branch
- **THEN** the thread lists the sessions, loads that review and reads that board before answering

#### Scenario: The briefing forbids nothing
- **WHEN** the rendered briefing is inspected
- **THEN** it contains no instruction forbidding a write, a commit, a push or a pull request, and does contain the steer toward staging

#### Scenario: A flag flip removes a tool
- **WHEN** a command is removed from the agent-exposed set
- **THEN** the next session thread created lists no tool for it

#### Scenario: Reading a large board
- **WHEN** the thread reads a board with more elements than the tool's cap
- **THEN** the result carries the cap's worth, a marker saying how many were elided, and a cursor

### Requirement: The session thread runs on the council's routing

The session thread SHALL be created with the model selection the council resolves for its orchestrator-chat job, on whichever installed provider the council routes it to. When no installed provider answers the job, the thread SHALL still open on the sidecar's default selection and the daemon SHALL log that fallback.

#### Scenario: Codex routed
- **WHEN** the council routes orchestrator-chat to Codex and Codex is installed
- **THEN** the session thread is a Codex thread and is briefed through Codex's developer instructions

#### Scenario: No provider for the job
- **WHEN** the council's pick names a provider that is not installed
- **THEN** the thread opens on the default selection and the log names the fallback

### Requirement: An Explain names its anchor

An anchored question sent to the session thread SHALL name what the reference is — the board, the lens, the path and the line range — in words before any structured reference, within the bounds the anchored ask already declares.

#### Scenario: Explain from a Flagged span
- **WHEN** the reviewer highlights a Flagged finding's cited lines and asks Explain
- **THEN** the turn's text names Flagged, the path and the lines, and the answer can cite them
