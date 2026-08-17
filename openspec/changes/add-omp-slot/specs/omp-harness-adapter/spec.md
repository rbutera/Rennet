# omp-harness-adapter Delta Specification

## Purpose

The omp adapter is the third harness slot (R23): it drives the user's own installed `omp` (`@oh-my-pi/pi-coding-agent`) through the normalized `HarnessPort` protocol, capable by default, with every capability flag earned through the shared conformance suite and honest Bun-aware health when the runtime is missing.

## ADDED Requirements

### Requirement: The omp adapter drives an injected NDJSON turn transport

The omp adapter SHALL be written against an injected turn transport (the peer of the Claude adapter's injected query function and the Codex adapter's injected exec transport), so the adapter package is fully testable without spawning a process. The composition root SHALL implement the transport by spawning the discovered `omp` binary in its line-delimited JSON RPC mode in the session's `cwd` as a fresh ephemeral session per turn (no session persistence), and one `HarnessSession` SHALL run exactly one turn (the single-turn contract every live `HarnessPort` consumer holds). The wire mapping SHALL restrict itself to the RPC subset shared with `pi` (R23's compatible subset), so omp-only protocol extras never leak into the normalization.

#### Scenario: A turn round-trips to a completed outcome through the transport

- **WHEN** the injected transport yields a session-start frame, streamed frames, and a terminal frame carrying final text and token usage
- **THEN** the adapter emits `session.started`, the intermediate events, and a `session.ended` completed outcome carrying the final text and the real usage, with strictly increasing `seq`

#### Scenario: The transport is not spawned until a turn runs

- **WHEN** an omp adapter is constructed and its descriptor read, but no session sends a turn
- **THEN** the transport has not been invoked and no process has been spawned

### Requirement: Sessions are capable by default and carry no approval plumbing

An omp session SHALL run with full capability on the acting path: the composed invocation SHALL select omp's non-interactive full-capability mode (no approval prompts, no write gating), and the adapter SHALL contain no approval-request handling, no consent surface, and no read-only posture. The ACP entry point, whose distinguishing feature is a permission-request protocol, SHALL NOT be the transport.

#### Scenario: The composed invocation is full-capability

- **WHEN** the composition root builds the invocation for a session turn
- **THEN** it selects the non-interactive full-capability mode and contains no approval, gating, or read-only flag

### Requirement: Every native frame is normalized or passed through, never dropped

The adapter SHALL normalize the transport's streamed frames into the existing `HarnessEvent` protocol with tolerant structural decoders: known frames map to their event kinds (session start, text, tool calls with `ToolKind` classification, terminal outcome), and any unmodelled frame SHALL surface as a `passthrough` event whose `native` field holds the original frame verbatim. Events SHALL carry the adapter-assigned monotonic `seq`, never a harness clock. A transport failure (nonzero exit, spawn failure, unparseable terminal state) SHALL surface as a normalized `HarnessError` with a closed `class` and an `origin`, ending the session with a `failed` outcome; `interrupt()`, `close()`, or an aborted `signal` SHALL terminate the spawned process tree and resolve only after transport completion.

#### Scenario: An unmodelled frame arrives mid-stream

- **WHEN** the transport yields a frame shape the adapter does not model
- **THEN** a `passthrough` event carrying the raw frame is emitted in sequence and the turn continues undisturbed

#### Scenario: A spawn failure becomes a failed outcome

- **WHEN** the composed process cannot start or exits nonzero before a terminal frame
- **THEN** the session ends with a `failed` outcome whose error names a class and origin, and the raw output is not silently discarded

### Requirement: The descriptor is evidence-derived and claims nothing unproven

The omp descriptor's capability flags SHALL be built only from `buildCapabilities` evidence produced by passing conformance-suite checks, and its `testedRange` SHALL be read from the committed conformance artifact, which SHALL have no omp entry until the first genuine real run fully matches the expected capability matrix. Because no turn has ever been executed against omp (the protocol research deliberately declined to invent the mapping table), hermetic fakes SHALL model only documented wire shapes, and no evidence layer beyond `implementedByAdapter` SHALL exist without a gated real run against the installed binary.

#### Scenario: A fresh adapter with no evidence

- **WHEN** a descriptor is built with no conformance evidence supplied
- **THEN** every layer of every capability is `false` and `testedRange` is absent-honest rather than invented

#### Scenario: The default gate spends nothing on omp

- **WHEN** the repository's default gate runs the conformance suite for the omp slot
- **THEN** it runs only against the in-process fake transport, spawns no process, and produces at most `implementedByAdapter` evidence

#### Scenario: A gated real run earns the outer layers

- **WHEN** the opt-in real conformance run executes against the installed `omp` binary and every capability matches the expected matrix
- **THEN** passing checks produce `advertisedByHarness`/`availableInSession` evidence and the run records the binary version into the committed tested-range artifact

### Requirement: Discovery health degrades honestly when the Bun runtime is absent

omp requires the Bun runtime to execute. Discovery of the omp slot SHALL prove both the `omp` binary and a runnable `bun`, and when `omp` is present but Bun is not, SHALL report health as unavailable (or degraded, when omp itself still answers) with a reason that names the missing Bun runtime — never a crash at first spawn, and never a claim that no omp is installed.

#### Scenario: omp present, Bun absent

- **WHEN** discovery resolves an `omp` binary but no runnable `bun` exists on the harvested PATH or curated locations
- **THEN** the reported health carries a reason naming the missing Bun runtime, the app keeps working, and no session can be created against the slot

#### Scenario: Both present

- **WHEN** discovery resolves `omp` and a runnable `bun`, and `omp` answers its version probe
- **THEN** the slot reports `ready` with the proven version

### Requirement: The orchestrator seat works with omp selected

The desktop composition SHALL be able to resolve the existing `orchestrator-chat` seat to the omp slot: an omp-selected turn SHALL run through the omp adapter's port and SHALL attach the same live canvasOps backend through the external loopback MCP transport the Codex path uses — the identical tool descriptors, with no harness-conditional branching in the canvasOps layer. The default resolution policy SHALL serve the seat with omp when it is the only installed harness (where today no orchestrator is available at all); the Model Council's Claude/Codex assignment tables SHALL remain unchanged.

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
