# codex-harness-adapter — app-server session transport

## REMOVED Requirements

### Requirement: The Codex adapter drives an injected exec transport

_Superseded by "The Codex adapter drives an injected app-server session transport"._

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: The composition root composes locus-aware Codex invocations

For a WSL-locus project, the composition root SHALL compose the `codex app-server` invocation to execute inside the distro: the spawn routes through the locus command wrapper (verbatim argv, no shell interpretation) and the `cwd` handed to `turn/start` is the distro-native repo path. JSON-RPC over stdio crosses the locus boundary unchanged (stdio is locus-transparent), so no scratch-file translation is required on the turn path. For a host-locus project, composition behavior is identical to host behavior before this change apart from the transport swap itself. The adapter package SHALL remain transport-injected and process-free.

#### Scenario: A WSL-locus turn executes in the distro

- **WHEN** the composition root builds a codex turn for a WSL-locus project
- **THEN** the spawned command enters the named distro and the `turn/start` cwd is the distro-native repo path

#### Scenario: Host composition spawns the host binary

- **WHEN** the composition root builds a codex turn for a host-locus project
- **THEN** the discovered host codex binary is spawned directly with the host repo path as cwd

### Requirement: Sessions are capable by default and carry no approval plumbing

A codex session SHALL run with full capability on the acting path: the composed `thread/start`/`turn/start` parameters SHALL select the full-access sandbox policy and the never-ask approval policy, and the adapter SHALL contain no approval-request handling, no consent surface, and no read-only posture. Server-initiated approval requests SHALL never block a turn (the composed policies make them unreachable; an unexpected one is answered in the affirmative and surfaced as evidence, never queued for a human). A session that only reads is a prompt outcome, not a capability the adapter withholds.

#### Scenario: The composed turn parameters are full-capability

- **WHEN** the composition root builds the thread and turn parameters for a session turn
- **THEN** they select the full-access sandbox policy and never-ask approvals, and contain no gating configuration
