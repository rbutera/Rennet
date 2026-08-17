# codex-harness-adapter

The second harness slot (#25): a `CodexAdapter` implementing the normalized `HarnessPort` over the user's own installed `codex` binary, peer of the Claude adapter. The transport is `codex exec --json` behind an injected seam (the app-server JSON-RPC protocol is deferred until steering or thread-resume is actually consumed; the seam is where it lands). The Rule Zero amendment governs: no approval apparatus, no fail-closed request handling, no capability withholding — sessions run capable by default so the agent can act.

## ADDED Requirements

### Requirement: The Codex adapter drives an injected exec transport

The Codex adapter SHALL be written against an injected turn transport (the peer of the Claude adapter's injected `ClaudeQueryFn`), so the adapter package is fully testable without spawning a process. The composition root SHALL implement the transport by spawning the discovered `codex` binary (`discoverCodex`) as `codex exec --json` in the session's `cwd` with stdin closed, `--ignore-user-config` plus Rennet's own explicit config overrides, and — when the session spec carries an `outputSchema` — `--output-schema` with last-message capture. One `HarnessSession` SHALL run exactly one turn (the slice-1 single-turn contract the live consumers already hold).

#### Scenario: A turn round-trips to a completed outcome through the transport

- **WHEN** the injected transport yields a session-start frame, streamed item frames, and a terminal frame with a schema-conformant last message and token usage
- **THEN** the adapter emits `session.started`, the intermediate events, and a `session.ended` completed outcome carrying the structured output and the real usage, with strictly increasing `seq`

#### Scenario: The transport is not spawned until a turn runs

- **WHEN** a `CodexAdapter` is constructed and its descriptor read, but no session sends a turn
- **THEN** the transport has not been invoked and no process has been spawned

### Requirement: Sessions are capable by default and carry no approval plumbing

A codex session SHALL run with full capability on the acting path: the composed invocation SHALL select the non-interactive full-access mode (no sandbox confinement, no approval prompts), and the adapter SHALL contain no approval-request handling, no consent surface, and no read-only posture. A session that only reads is a prompt outcome, not a capability the adapter withholds.

#### Scenario: The composed invocation is full-capability

- **WHEN** the composition root builds the argv for a session turn
- **THEN** it selects the non-interactive full-access mode and contains no approval, gating, or read-only flag

### Requirement: Every native frame is normalized or passed through, never dropped

The adapter SHALL normalize the transport's streamed JSONL frames into the existing `HarnessEvent` protocol with tolerant structural decoders: known frames map to their event kinds (session start, text, tool calls with `ToolKind` classification, terminal outcome), and any unmodelled frame SHALL surface as a `passthrough` event whose `native` field holds the original frame verbatim. Events SHALL carry the adapter-assigned monotonic `seq`, never a harness clock.

#### Scenario: An unmodelled frame arrives mid-stream

- **WHEN** the transport yields a frame shape the adapter does not model
- **THEN** a `passthrough` event carrying the raw frame is emitted in sequence and the turn continues undisturbed

#### Scenario: A tool-use frame is classified

- **WHEN** the transport yields an `item.started` or `item.completed` frame whose official `item.type` is command execution, MCP tool call, or file change
- **THEN** the adapter classifies its `kind` (`exec`, `mcp`, or `write`) from `item.type` (`item.item_type` is accepted only as a compatibility fallback), uses the stable item id, emits `tool.started` for the start, and emits `tool.output` with the native result and success status for a completed command or MCP item

#### Scenario: Token accounting keeps disjoint fields

- **WHEN** a completed turn reports input tokens, cached input tokens, cache-write input tokens, and output tokens
- **THEN** normalized input excludes cached input, cache read and cache write remain separate, and total is the sum of the disjoint normalized fields

### Requirement: Failures map into the error taxonomy and interrupt kills the subprocess

A transport failure (nonzero exit, unparseable terminal state, spawn failure) SHALL surface as a normalized `HarnessError` carrying a closed `class`, an `origin` (`harness`, `provider`, or `transport`), and the retryability source, terminating the session with a `failed` outcome. `interrupt()`, `close()`, or an aborted `signal` SHALL terminate the whole spawned process tree. `interrupt()` and `close()` SHALL await transport completion before resolving.

#### Scenario: A nonzero exit becomes a failed outcome

- **WHEN** the spawned `codex exec` exits nonzero before a terminal frame
- **THEN** the session ends with a `failed` outcome whose error names a class and origin, and the raw output is not silently discarded

#### Scenario: An aborted signal cancels the turn

- **WHEN** the session's `signal` aborts while a turn is in flight
- **THEN** the subprocess and its descendants terminate and the session ends with a `cancelled` outcome before interrupt or close resolves

#### Scenario: Events are subscribe-once

- **WHEN** a caller accesses one session's `events` stream a second time
- **THEN** access throws a plain descriptive error and no second transport process is spawned

### Requirement: Desktop composition selects the Codex adapter for Codex-selected orchestrator turns

The desktop composition root SHALL resolve the existing `orchestrator-chat` consumer through the selected harness. When that seat selects Codex, it SHALL construct the agentic `CodexAdapter` over the injected `CodexTurnTransport`, attach the same live canvasOps backend through its loopback MCP URL, and run the orchestrator turn through that port. This change SHALL NOT introduce additional Codex consumers beyond the paths named by this change.

#### Scenario: A Codex-selected orchestrator reaches the injected transport

- **WHEN** desktop composition resolves `orchestrator-chat` to Codex and runs a turn against an injected hermetic transport
- **THEN** the injected transport receives the turn, including the loopback canvasOps URL, and its normalized result is returned by the orchestrator path

### Requirement: The adapter never opens a credential path

The adapter and its composition root SHALL never read a harness credential file (Codex `auth.json` included), relying on the spawned `codex` to authenticate itself on the user's own subscription.

#### Scenario: A session runs end to end

- **WHEN** a session is created and a turn runs through the real composition root
- **THEN** no credential file path is read, and the safety check that would catch such a read is proven able to fire

### Requirement: The descriptor is evidence-derived

The `CodexAdapter` descriptor's capability flags SHALL be built only from `buildCapabilities` evidence produced by passing conformance checks, and its `testedRange` SHALL be read from the recorded conformance artifact (`harness-conformance`), never hand-edited.

#### Scenario: A fresh adapter with no evidence

- **WHEN** a descriptor is built with no conformance evidence supplied
- **THEN** every layer of every capability is `false`
