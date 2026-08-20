# canvasops-mcp-surface Specification

## Purpose
Defines the versioned canvas operations available to orchestrator sessions through in-process and loopback MCP transports.
## Requirements
### Requirement: canvasOps@2 provides one versioned set of interaction and retrieval tools
The system SHALL expose `canvasOps@2` with six interaction ops: `canvas.describe`, `canvas.view`, `canvas.focus`, `canvas.annotate`, `canvas.propose`, and `canvas.recompute`. It SHALL also expose seven read-only retrieval ops: `canvas.read`, `canvas.thread`, `diff.read`, `diff.search`, `diff.structure`, `run.ledger`, and `run.provenance`. The tool descriptors SHALL contain no harness-specific branches. Claude SHALL receive them through an in-process MCP server built with the Agent SDK's `createSdkMcpServer`. Other harnesses SHALL receive the same descriptors through a streamable HTTP MCP transport on a loopback address. Both transports SHALL compile from `CANVAS_OPS_TOOLS` and use the same live backend.

#### Scenario: An orchestrator session describes counts and cohorts before reading an element
- **WHEN** the session invokes `canvas.describe` at `counts`, then `canvas.describe` at `cohorts`, then `canvas.read` for one element
- **THEN** each call returns the uniform envelope at the requested detail level, and the element read returns that element's full content

#### Scenario: The hot trio is always-loaded
- **WHEN** the SDK server is built
- **THEN** `canvas.describe` and `canvas.view` are marked always-loaded and the read-only tools carry `readOnlyHint`

#### Scenario: The external transport serves the identical tool list
- **WHEN** an MCP client connects to the loopback streamable-HTTP server and lists tools
- **THEN** the tool names and schemas equal the in-process server's because both compile from `CANVAS_OPS_TOOLS`, and a describe-to-read round trip returns the same envelopes

#### Scenario: A Codex session describes and reads through the external transport
- **WHEN** the orchestrator slot runs with codex picked, its session configured with the loopback canvasOps URL
- **THEN** the session's `canvas.describe` and `canvas.read` calls reach the live backend through the external transport in both hermetic and opt-in live tests

#### Scenario: The external lifecycle closes once

- **WHEN** the owner closes an attached Codex orchestrator session more than once
- **THEN** one idempotent lifecycle closes the harness session, listener, and MCP transport without leaving an independently owned handle

#### Scenario: The listener fails before listening

- **WHEN** the HTTP listener emits an error before its listening event
- **THEN** creation rejects and cleans up the listener and MCP transport rather than leaving the promise unsettled

### Requirement: Every reply carries freshness and complete pagination
Every tool reply SHALL carry a `freshness` verdict. A non-current verdict SHALL appear on the reply so consumers can identify stale data. Any tool that returns a list SHALL include the true `total` and a cursor that reaches the end. It SHALL NOT silently cap results.

#### Scenario: Stale freshness rides the next reply after a patchset advance
- **WHEN** the backend reports the canvas is stale after a seeded patchset advance
- **THEN** the next `canvas.describe` reply carries `freshness: "stale"`

#### Scenario: A canvas bigger than one page walks to completion with a correct total
- **WHEN** `canvas.describe` at `elements` is paged with a limit smaller than the element count
- **THEN** the first page carries the true `total` and a non-null cursor, and following the cursor to the end yields every element exactly once with a final `null` cursor

#### Scenario: Nothing found is distinguished from a failed search
- **WHEN** a retrieval tool matches nothing
- **THEN** it returns a success envelope with `total: 0` and the searched scope named, distinguishable from a structured error

### Requirement: The tools write L3 but never L2
The tools SHALL contain no user-only op for dispositions, adjudication, expansion, selection, pinning, or clearing. They SHALL contain no engine-only op for projection, invalidation, carry, or ordering. No handler SHALL produce an L2 disposition write. Orchestrator dispatch SHALL exclude L2 from its effect union. `canvas.propose` MAY carry many anchors in one L3 proposal, which becomes L2 only when the user adjudicates it. `canvas.recompute` SHALL refuse before a model runs when its RoutePlan exceeds the invocation budget.

#### Scenario: The tool list contains no user-only or engine-only op
- **WHEN** the tool names are enumerated
- **THEN** none of the user command vocabulary or the engine command vocabulary appears

#### Scenario: A bulk proposal is L3 and only user adjudication creates L2
- **WHEN** `canvas.propose` raises a disposition proposal covering many anchors, and its effect is folded into canvas state
- **THEN** the proposal is a pending L3 proposal and no L2 disposition exists until the user adjudicates it (a user command)

#### Scenario: Recompute over budget refuses before any model runs
- **WHEN** `canvas.recompute` is called with a scope whose plan exceeds the RoutePlan budget
- **THEN** it returns a visible refusal in the envelope and raises no recompute effect
