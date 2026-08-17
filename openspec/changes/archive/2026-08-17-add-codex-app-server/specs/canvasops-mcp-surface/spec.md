# canvasops-mcp-surface

Delta for #25: the existing "other slots reach the same descriptors as external MCP later" clause becomes real. The one surface gains a second transport — loopback streamable HTTP — so a codex (and later omp) session reaches the identical contract with no harness branching.

## MODIFIED Requirements

### Requirement: canvasOps@2 is one versioned surface of interaction + retrieval tools
The system SHALL expose `canvasOps@2` as a single versioned tool surface containing the six interaction ops (`canvas.describe`, `canvas.view`, `canvas.focus`, `canvas.annotate`, `canvas.propose`, `canvas.recompute`) and the seven read-only retrieval ops (`canvas.read`, `canvas.thread`, `diff.read`, `diff.search`, `diff.structure`, `run.ledger`, `run.provenance`). The tool descriptors SHALL be a harness-agnostic contract with no `if (harness === X)` branching. The Claude slot reaches them as an in-process MCP server built with the Agent SDK's `createSdkMcpServer`; every other slot SHALL reach the SAME descriptors through an external streamable-HTTP MCP transport served from the desktop process on a loopback address, compiled from the same neutral `CANVAS_OPS_TOOLS` catalogue and backed by the same live backend — one contract, two transports, no per-harness tool surface.

#### Scenario: An orchestrator session round-trips describe(counts)→describe(cohorts)→read
- **WHEN** the surface is invoked with `canvas.describe` at `counts`, then `canvas.describe` at `cohorts`, then `canvas.read` of one element
- **THEN** each call returns the uniform envelope with the requested altitude of data, and the element read returns that element's full content

#### Scenario: The hot trio is always-loaded
- **WHEN** the SDK server is built
- **THEN** `canvas.describe` and `canvas.view` are marked always-loaded and the read-only tools carry `readOnlyHint`

#### Scenario: The external transport serves the identical tool list
- **WHEN** an MCP client connects to the loopback streamable-HTTP server and lists tools
- **THEN** the tool names and schemas equal the in-process server's — compiled from the same `CANVAS_OPS_TOOLS` catalogue — and a describe→read round-trip through it returns the same envelopes as the in-process path

#### Scenario: A codex-slot session round-trips describe→read
- **WHEN** the orchestrator slot runs with codex picked, its session configured with the loopback canvasOps URL
- **THEN** the session's `canvas.describe` → `canvas.read` calls round-trip through the external transport against the live backend (proven hermetically with an MCP client in the gate, and live in the gated real test)

#### Scenario: The external lifecycle closes once

- **WHEN** the owner closes an attached Codex orchestrator session more than once
- **THEN** one idempotent lifecycle closes the harness session, listener, and MCP transport without leaving an independently owned handle

#### Scenario: The listener fails before listening

- **WHEN** the HTTP listener emits an error before its listening event
- **THEN** creation rejects and cleans up the listener and MCP transport rather than leaving the promise unsettled
