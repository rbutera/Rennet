# omp-harness-adapter Delta Specification

## Purpose

The omp adapter is the third harness slot (R23): it drives the user's own installed `omp` (`@oh-my-pi/pi-coding-agent`) through the normalized `HarnessPort` protocol, capable by default, with every capability flag earned through the shared conformance suite and honest Bun-aware health when the runtime is missing.

## ADDED Requirements

### Requirement: The omp adapter drives an injected NDJSON turn transport

The omp adapter SHALL be written against an injected turn transport (the peer of the Claude adapter's injected query function and the Codex adapter's injected exec transport), so the adapter package is fully testable without spawning a process. The composition root SHALL implement the transport by spawning the discovered `omp` binary in its line-delimited JSON RPC mode in the session's `cwd` as a fresh ephemeral session per turn (no session persistence), and one `HarnessSession` SHALL run exactly one turn (the single-turn contract every live `HarnessPort` consumer holds). The wire mapping SHALL restrict itself to the RPC subset shared with `pi` (R23's compatible subset), so omp-only protocol extras never leak into the normalization.

#### Scenario: A turn round-trips to a completed outcome through the transport

- **WHEN** the injected transport yields a session-start frame, streamed frames, and a terminal frame carrying final text
- **THEN** the adapter emits `session.started`, the intermediate events, and a `session.ended` completed outcome carrying the final text, with strictly increasing `seq`; usage remains absent until the real transport requests stats

#### Scenario: The transport is not spawned until a turn runs

- **WHEN** an omp adapter is constructed and its descriptor read, but no session sends a turn
- **THEN** the transport has not been invoked and no process has been spawned

### Requirement: Sessions are capable by default and carry no approval plumbing

An omp session SHALL run with full capability on the acting path: the composed invocation SHALL select omp's non-interactive full-capability mode (no approval prompts, no write gating), and the adapter SHALL contain no approval-request handling, no consent surface, and no read-only posture. The ACP entry point, whose distinguishing feature is a permission-request protocol, SHALL NOT be the transport.

#### Scenario: The composed invocation is full-capability

- **WHEN** the composition root builds the invocation for a session turn
- **THEN** it selects the non-interactive full-capability mode and contains no approval, gating, or read-only flag

### Requirement: Every native frame is normalized or passed through, never dropped

The adapter SHALL normalize the transport's streamed frames into the existing `HarnessEvent` protocol with tolerant structural decoders: known frames map to their event kinds (session start, text, tool calls with `ToolKind` classification, terminal outcome), and any unmodelled frame SHALL surface as a `passthrough` event whose `native` field holds the original frame verbatim. Events SHALL carry the adapter-assigned monotonic `seq`, never a harness clock. Any RPC response with `success: false`, nonzero exit, spawn/construction/iteration failure, malformed frame, oversized frame, or unparseable terminal state SHALL surface as a normalized `HarnessError` with a closed `class` and an `origin`, ending the session with exactly one `failed` outcome; `interrupt()`, `close()`, or an aborted `signal` SHALL terminate the spawned process tree and resolve only after transport completion. Stdout frame and stderr accumulation SHALL be byte-bounded. The `events` iterable SHALL be single-use even when one captured handle is iterated twice.

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

#### Scenario: JSON text is not structured-output evidence

- **WHEN** omp returns JSON text for a session that requested an output schema
- **THEN** `structuredOutput` remains absent because the RPC prompt neither receives nor enforces that schema, and the capability remains expected-fail

### Requirement: Discovery health degrades honestly when the Bun runtime is absent

omp requires the Bun runtime to execute. Discovery SHALL resolve Bun before probing omp, enforce Bun `>=1.3.14`, and carry the exact proven runtime into process composition so the omp script is both probed and launched through it. When `omp` is present but Bun is missing or below floor, health SHALL be unavailable with a reason that names Bun and the resolved omp path — never a generic no-version branch or a first-spawn crash. Omp ranking SHALL demote an asdf shim behind a real install, and Windows filename matching SHALL consume the candidate locus's `PATHEXT`.

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
