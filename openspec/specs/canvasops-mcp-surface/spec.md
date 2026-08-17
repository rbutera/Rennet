# canvasops-mcp-surface Specification

## Purpose
TBD - created by archiving change build-canvasops-mcp-surface. Update Purpose after archive.
## Requirements
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

### Requirement: Every reply carries a freshness verdict and pagination is honest with totality
Every tool reply SHALL carry a `freshness` verdict on the answer itself (R30 at the reply, not only at boot); a non-current verdict SHALL ride on the reply so stale ground is never consumed silently. Any list-returning tool SHALL paginate with totality: the response SHALL carry the true `total` and a cursor that walks to completion, and a silent cap is forbidden (correction 4 applied to the machine reader).

#### Scenario: Stale freshness rides the next reply after a patchset advance
- **WHEN** the backend reports the canvas is stale after a seeded patchset advance
- **THEN** the next `canvas.describe` reply carries `freshness: "stale"`

#### Scenario: A canvas bigger than one page walks to completion with a correct total
- **WHEN** `canvas.describe` at `elements` is paged with a limit smaller than the element count
- **THEN** the first page carries the true `total` and a non-null cursor, and following the cursor to the end yields every element exactly once with a final `null` cursor

#### Scenario: Nothing found is distinguished from a failed search
- **WHEN** a retrieval tool matches nothing
- **THEN** it returns a success envelope with `total: 0` and the searched scope named, distinguishable from a structured error

### Requirement: The surface is structurally read/L3-only — the human still disposes
The surface SHALL contain no user-only op (disposition, adjudicate, expand/collapse, select, pin/clear) and no engine-only op (project, invalidate, carry, order). No handler SHALL produce an L2 disposition write: write ops route through issue #10's orchestrator dispatch, whose effect union excludes L2. `canvas.propose` MAY carry many anchors in one proposal (bulk), rendered on L3; the proposal becomes L2 only when the user adjudicates it. `canvas.recompute` SHALL be gated by the RoutePlan budget and refuse before any model runs when over budget.

#### Scenario: The tool list contains no user-only or engine-only op
- **WHEN** the surface's tool names are enumerated
- **THEN** none of the user command vocabulary or the engine command vocabulary appears

#### Scenario: A bulk proposal is L3 and only user adjudication creates L2
- **WHEN** `canvas.propose` raises a disposition proposal covering many anchors, and its effect is folded into canvas state
- **THEN** the proposal is a pending L3 proposal and no L2 disposition exists until the user adjudicates it (a user command)

#### Scenario: Recompute over budget refuses before any model runs
- **WHEN** `canvas.recompute` is called with a scope whose plan exceeds the RoutePlan budget
- **THEN** it returns a visible refusal in the envelope and raises no recompute effect

