# Omp harness adapter specification

## Purpose
Define the omp adapter's discovery, Bun runtime, NDJSON turn transport, normalized events, evidence-backed capabilities, canvasOps connection, and orchestrator routing.
## Requirements
### Requirement: The omp adapter drives an injected NDJSON turn transport

The omp adapter SHALL use an injected turn transport, matching the injection seams used by the Claude and Codex adapters. Adapter tests SHALL run without spawning a process. The production transport SHALL spawn the discovered `omp` binary in its line-delimited JSON RPC mode with the session's `cwd`. It SHALL create a fresh session for each turn, and each `HarnessSession` SHALL run exactly one turn. The wire mapping SHALL use the RPC subset shared with `pi` and SHALL NOT expose omp-specific protocol fields through the normalized harness protocol.

#### Scenario: A turn round-trips to a completed outcome through the transport

- **WHEN** the injected transport yields a session-start frame, streamed frames, and a terminal frame carrying final text
- **THEN** the adapter emits `session.started`, the intermediate events, and a `session.ended` completed outcome carrying the final text, with strictly increasing `seq`; usage remains absent until the real transport requests stats

#### Scenario: The transport is not spawned until a turn runs

- **WHEN** an omp adapter is constructed and its descriptor read, but no session sends a turn
- **THEN** the transport has not been invoked and no process has been spawned

### Requirement: Sessions run with full acting capability

An omp session SHALL run in non-interactive full-capability mode. The adapter SHALL NOT add permission requests, restrict writes, or use ACP as its transport.

#### Scenario: The composed invocation is full-capability

- **WHEN** the composition root builds the invocation for a session turn
- **THEN** it selects non-interactive full-capability mode without a read-only flag or permission-request protocol

### Requirement: Every native frame is normalized or passed through, never dropped

The adapter SHALL normalize known transport frames into session-start, text, classified tool-call, and terminal `HarnessEvent` values. An unknown frame SHALL produce a `passthrough` event whose `native` field contains the original frame. Events SHALL use an adapter-assigned monotonic `seq`, not a harness clock. A response with `success: false`, a nonzero exit, a spawn or iteration failure, a malformed or oversized frame, or an unparseable terminal state SHALL produce a normalized `HarnessError` and exactly one `failed` outcome. `interrupt()`, `close()`, and an aborted `signal` SHALL terminate the process tree and resolve after transport completion. The transport SHALL bound stdout frames and accumulated stderr. The `events` iterable SHALL allow one subscription.

#### Scenario: An unmodelled frame arrives mid-stream

- **WHEN** the transport yields a frame shape the adapter does not model
- **THEN** a `passthrough` event carrying the raw frame is emitted in sequence and the turn continues undisturbed

#### Scenario: A spawn failure becomes a failed outcome

- **WHEN** the composed process cannot start or exits nonzero before a terminal frame
- **THEN** the session ends with a `failed` outcome whose error names a class and origin, and the raw output is not silently discarded

#### Scenario: A rejected RPC command cannot complete cleanly

- **WHEN** omp emits any `{ type: "response", success: false, error }` frame and then exits zero
- **THEN** the response is preserved as native error evidence and the terminal outcome is `failed`, never `completed`

#### Scenario: Corrupt or oversized stdout is bounded and visible

- **WHEN** omp emits malformed JSON, an oversized line, or an unterminated line and exits zero
- **THEN** the bounded protocol evidence is emitted and the turn ends `failed`; no corrupt frame is silently dropped

### Requirement: The descriptor is evidence-derived and claims nothing unproven

The omp descriptor SHALL build capability flags only from `buildCapabilities` evidence produced by passing conformance checks. It SHALL read `testedRange` from the committed conformance artifact. Without a complete matching real run, the artifact SHALL have no omp entry. Hermetic fakes SHALL model only documented wire shapes and SHALL produce at most `implementedByAdapter` evidence.

#### Scenario: A fresh adapter with no evidence

- **WHEN** a descriptor is built with no conformance evidence supplied
- **THEN** every layer of every capability is `false` and `testedRange` is absent-honest rather than invented

#### Scenario: the default gate spends nothing on omp

- **WHEN** the repository's default gate runs the conformance suite for the omp slot
- **THEN** it runs only against the in-process fake transport, spawns no process, and produces at most `implementedByAdapter` evidence

#### Scenario: an opt-in real run earns the outer layers

- **WHEN** the opt-in real conformance run executes against the installed `omp` binary and every capability matches the expected matrix
- **THEN** passing checks produce `advertisedByHarness`/`availableInSession` evidence and the run records the binary version into the committed tested-range artifact

#### Scenario: JSON text is not structured-output evidence

- **WHEN** omp returns JSON text for a session that requested an output schema
- **THEN** `structuredOutput` remains absent because the RPC prompt neither receives nor enforces that schema, and the capability remains expected-fail

### Requirement: Discovery health degrades honestly when the Bun runtime is absent

Omp requires Bun. Discovery SHALL resolve Bun before probing omp, require Bun `>=1.3.14`, and carry the proven Bun path into process composition. The probe and turn SHALL use that path. If omp resolves but Bun is missing or below the minimum, health SHALL be unavailable with a reason that names Bun and the resolved omp path. Omp ranking SHALL place an asdf shim behind a direct install. Windows filename matching SHALL use the candidate environment's `PATHEXT`.

#### Scenario: omp present, Bun absent

- **WHEN** discovery resolves an `omp` binary but no runnable `bun` exists on the harvested PATH or curated locations
- **THEN** the reported health carries a reason naming the missing Bun runtime, the app keeps working, and no session can be created against the slot

#### Scenario: Both present

- **WHEN** discovery resolves `omp` and Bun `>=1.3.14`, and omp answers when executed through that exact Bun path
- **THEN** the slot reports `ready` with the proven version and composition carries the same runtime path

### Requirement: canvasOps uses a supported ephemeral MCP source

When a turn carries loopback MCP servers, composition SHALL write `mcp.json` at the root of the turn scratch extension and pass that directory through omp's supported `--extension` source. The JSON SHALL use `mcpServers.<name>.type: "http"` and the exact loopback URL. It SHALL NOT pass MCP declarations through `--config`, which omp treats as a settings overlay. Hermetic tests SHALL prove the exact filename, placement, parsed shape, URL, and invocation. Until a real turn runs, the ledger SHALL claim no live MCP connection evidence above `implementedByAdapter`.

#### Scenario: A canvasOps server is attached hermetically

- **WHEN** composition receives the canvasOps loopback URL
- **THEN** `<turn scratch>/mcp.json` contains `{ "mcpServers": { "canvasops": { "type": "http", "url": "<exact URL>" } } }` and omp receives `--extension <turn scratch>`

### Requirement: The orchestrator seat works with omp selected

The desktop composition SHALL resolve the `orchestrator-chat` seat to the omp slot when selected. The turn SHALL run through the omp adapter and attach the live canvasOps backend through the external loopback MCP transport. Omp and Codex SHALL receive identical canvasOps tool descriptors without harness-specific branches. The default policy SHALL choose omp when it is the only installed harness. The Model Council's Claude and Codex assignment tables SHALL remain unchanged.

#### Scenario: An omp-selected orchestrator reaches the injected transport

- **WHEN** desktop composition resolves `orchestrator-chat` to omp and runs a turn against an injected hermetic transport
- **THEN** the injected transport receives the turn, including the loopback canvasOps URL, and its normalized result is returned by the orchestrator path

#### Scenario: omp as the only installed harness

- **WHEN** neither Claude nor Codex is discoverable and a healthy omp slot is
- **THEN** the orchestrator seat resolves to omp instead of reporting that no model harness is available

### Requirement: The adapter never opens a credential path

The adapter and its composition root SHALL never read a harness credential file, relying on the spawned `omp` to authenticate itself on the user's own configuration. Nothing SHALL bundle an `omp` or `bun` binary.

#### Scenario: A session runs end to end

- **WHEN** a session is created and a turn runs through the real composition root
- **THEN** no credential file path is read, and the safety check that would catch such a read is proven able to fire
