# codex-harness-adapter Specification

## Purpose
TBD - created by archiving change add-codex-app-server. Update Purpose after archive.
## Requirements
### Requirement: The Codex adapter drives an injected app-server session transport

The Codex adapter SHALL be written against an injected turn transport (the peer of the Claude adapter's injected `ClaudeQueryFn`), so the adapter package is fully testable without spawning a process. The composition root SHALL implement the transport by spawning the discovered codex binary as `codex app-server` and speaking newline-delimited JSON-RPC 2.0 over its stdio: `initialize` (client info), `thread/start`, then `turn/start` carrying the prompt input, `cwd`, model/effort, the full-capability sandbox policy, and — when the session spec carries an `outputSchema` — the protocol's first-class `outputSchema` turn parameter. One `HarnessSession` SHALL run exactly one turn; the child process is turn-scoped (spawned for the turn, terminated with it), preserving the shipped process-lifecycle semantics.

#### Scenario: A turn round-trips to a completed outcome through the transport

- **WHEN** the injected transport yields the thread/turn started events, streamed item notifications, and a `turn/completed` with a schema-conformant final agent message and token usage
- **THEN** the adapter emits `session.started`, the intermediate events, and a `session.ended` completed outcome carrying the structured output and the real usage, with strictly increasing `seq`

#### Scenario: The transport is not spawned until a turn runs

- **WHEN** a `CodexAdapter` is constructed and its descriptor read, but no session sends a turn
- **THEN** the transport has not been invoked and no process has been spawned

#### Scenario: Streamed items surface as session events

- **WHEN** the app-server streams `item/*` notifications (agent message deltas, command executions, reasoning) during a turn
- **THEN** each is normalized into the adapter's event stream or passed through, never silently dropped

### Requirement: Sessions are capable by default and carry no approval plumbing

A codex session SHALL run with full capability on the acting path: the composed `thread/start`/`turn/start` parameters SHALL select the full-access sandbox policy and the never-ask approval policy, and the adapter SHALL contain no approval-request handling, no consent surface, and no read-only posture. Server-initiated approval requests SHALL never block a turn (the composed policies make them unreachable; an unexpected one is answered in the affirmative and surfaced as evidence, never queued for a human). A session that only reads is a prompt outcome, not a capability the adapter withholds.

#### Scenario: The composed turn parameters are full-capability

- **WHEN** the composition root builds the thread and turn parameters for a session turn
- **THEN** they select the full-access sandbox policy and never-ask approvals, and contain no gating configuration

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

A transport failure (JSON-RPC error response, `turn/failed`, unparseable frame, process exit before a terminal notification, spawn failure) SHALL surface as a normalized `HarnessError` carrying a closed `class`, an `origin` (`harness`, `provider`, or `transport`), and the retryability source, terminating the session with a `failed` outcome; a `turn/failed` error message (auth expiry included) SHALL reach the outcome verbatim, never summarized away. `interrupt()`, `close()`, or an aborted `signal` SHALL send `turn/interrupt` and then terminate the whole spawned process tree. `interrupt()` and `close()` SHALL await transport completion before resolving.

#### Scenario: A turn failure becomes a failed outcome

- **WHEN** the app-server reports `turn/failed` (or exits before a terminal notification)
- **THEN** the session ends with a `failed` outcome whose error names a class and origin, and the native error message is preserved

#### Scenario: An aborted signal cancels the turn

- **WHEN** the session's `signal` aborts while a turn is in flight
- **THEN** `turn/interrupt` is sent, the subprocess and its descendants terminate, and the session ends with a `cancelled` outcome before interrupt or close resolves

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

### Requirement: The composition root composes locus-aware Codex invocations

For a WSL-locus project, the composition root SHALL compose the `codex app-server` invocation to execute inside the distro: the spawn routes through the locus command wrapper (verbatim argv, no shell interpretation) and the `cwd` handed to `turn/start` is the distro-native repo path. JSON-RPC over stdio crosses the locus boundary unchanged (stdio is locus-transparent), so no scratch-file translation is required on the turn path. For a host-locus project, composition behavior is identical to host behavior before this change apart from the transport swap itself. The adapter package SHALL remain transport-injected and process-free.

#### Scenario: A WSL-locus turn executes in the distro

- **WHEN** the composition root builds a codex turn for a WSL-locus project
- **THEN** the spawned command enters the named distro and the `turn/start` cwd is the distro-native repo path

#### Scenario: Host composition spawns the host binary

- **WHEN** the composition root builds a codex turn for a host-locus project
- **THEN** the discovered host codex binary is spawned directly with the host repo path as cwd

### Requirement: The canvasOps loopback surface is reachable from the executing locus

The canvasOps URL handed to a codex session SHALL be an address the executing codex can actually reach: the shipped loopback for host execution, and for a WSL-locus session an address routable from the distro (shared localhost under mirrored networking, or the WSL-facing host address otherwise), with the listener bound no wider than that route requires. When no distro-reachable route can be established, the turn SHALL fail with a plain reason naming the gap — never silently execute on the host instead, and never claim canvas capability the session does not have.

#### Scenario: Distro codex reaches canvasOps

- **WHEN** a WSL-locus codex session starts and a distro-to-host route exists
- **THEN** the session's canvasOps URL is reachable from inside the distro and canvas operations round-trip

#### Scenario: No route degrades honestly

- **WHEN** no distro-reachable address can be established for the canvasOps listener
- **THEN** the codex turn settles as failed with a reason naming the unreachable canvas surface, and no host-side codex runs as a silent substitute
