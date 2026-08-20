# Orchestrator session specification

## Purpose
Define the deterministic review primer, structured context updates, current-view injection, and canvasOps tools attached to an orchestrator session.
## Requirements
### Requirement: The orchestrator boots with a lean map-not-container primer

The system SHALL assemble a deterministic, versioned primer that maps the review without embedding its full contents. B1 SHALL identify the workspace, repository, review, patchset, lineage position, and mode. B2 SHALL list repository freshness up to a fixed cap, followed by one aggregate line for the remainder. B3 SHALL list per-canvas counts up to a fixed cap, followed by aggregate counts for the remainder. It SHALL include counts only and SHALL NOT inline the decisions list. B4 SHALL contain the protocol card. B5 SHALL index the live `canvasOps@2` tool names and their one-line usage guidance without schemas. B6 SHALL contain the run-ledger headline. The primer SHALL remain at or below 4,096 bytes for large multi-repository reviews. An overrun error SHALL remain as a backstop. `failed` and `updating` freshness SHALL count as not current. Rolled-up repositories and canvases SHALL remain available through tools.

#### Scenario: A fresh session answers orientation from the bootstrap without a tool call

- **WHEN** a fresh session boots with a primer for a review whose canvases carry dispositioned and undispositioned paths
- **THEN** the primer is ≤ 4 KB and its B3 section states, per canvas, the counts that answer "where are we" and "what have you not looked at yet" (unread / disposition-coverage), so the question is answerable from the primer text with no tool call

#### Scenario: Count-level state never inlines contents

- **WHEN** the primer's B3 canvas state is assembled for a review with many decisions
- **THEN** it carries the decision count without decision bodies or titles, and the decisions list remains reachable through tools

#### Scenario: A large multi-repo review assembles under the ceiling without throwing

- **WHEN** a primer is assembled for a review with at least 10 repos and 20 canvases
- **THEN** assembly succeeds deterministically with a primer ≤ 4,096 bytes whose B2 tail is exactly `… +4 more repos — 2 current / 2 not current` and whose B3 tail is exactly `… +15 more canvases — 180 elements, 75/120 dispositioned, 45 unread` for the acceptance fixture
- **AND** shuffled copies of that fixture produce the identical tails, bytes, and digest

### Requirement: Primer assembly is deterministic and the card is a versioned template
Primer assembly SHALL be a pure function of review state. Equal state SHALL produce identical bytes and an identical digest. The orchestrator session provenance SHALL record the primer's SHA-256 digest. The protocol card SHALL be a fixed, versioned base instruction matched byte-for-byte. It SHALL contain the four-actor contract, logical ordering, roll-up and zoom behavior, the orchestrator's excluded actions, and the ask protocol. The ask protocol SHALL include: "never answer about the base branch or unexamined code from recall; retrieve or ask first".

#### Scenario: Same state assembles to the same bytes and digest
- **WHEN** `assemblePrimer` is called twice with equal inputs
- **THEN** the two manifests carry identical `text`, identical `bytes`, and an identical `digest`

#### Scenario: The card matches its versioned template and the digest lands in provenance
- **WHEN** a session boots
- **THEN** the primer's card section equals the versioned `PROTOCOL_CARD` template, the card carries its version identifier, and the session's provenance records the primer digest and versions

### Requirement: User acts are pushed as structured events into the orchestrator's context
The system SHALL push user actions into orchestrator context as structured events. `{selected}` SHALL carry an anchor and element summary. `{disposed}` SHALL carry an anchor, type, and body. `{proposal-adjudicated}` SHALL carry the proposal id, outcome, and edited payload. `{viewing}` SHALL carry the canvas and cohort. The system SHALL NOT collect or derive dwell or pace metrics. The open assembled-prompt panel SHALL append every delivered event and show its exact bytes.

#### Scenario: A user selection appears in the next-turn context
- **WHEN** the user selects an element and the orchestrator takes its next turn
- **THEN** the `{selected}` event with its anchor is present in the next-turn context and byte-for-byte in the open-assembled-prompt panel

#### Scenario: A proposal dismissal teaches
- **WHEN** the user dismisses (or edits-then-accepts) an orchestrator proposal
- **THEN** a `{proposal-adjudicated}` event carrying the outcome and the edited payload is delivered into the context

### Requirement: The user's current view context is injected at request time
When the user asks a question, the system SHALL inject the user's current canvas/lens/view context into that request so the orchestrator resolves references like "this" without the user restating context.

#### Scenario: A question on the decisions lens carries that lens context
- **WHEN** the user is viewing the decisions lens and asks a question
- **THEN** the request built for the orchestrator carries the decisions lens (`angle: "decisions"`) and the current view context at request time

### Requirement: The stream consumes the change feed and batches view context under an injected clock
The context-update stream SHALL use `CanvasChangeFeed` and direct user-action events, delivered in store sequence order. It SHALL NOT use an Rx pipeline. Consumers MAY coalesce events but SHALL NOT reorder them. A bounded batcher under an injected clock SHALL coalesce `{viewing}` events by canvas key, with the later view replacing the earlier one. A coalesced delivery SHALL state the sequence range it covers.

#### Scenario: Two viewings of one canvas coalesce into one non-silent delivery
- **WHEN** the user views a canvas, then views it again within the batch window, and the clock advances past the window
- **THEN** exactly one `{viewing}` event is delivered for that canvas, stating the seq range it covers (spanning both viewings), and nothing is delivered silently

#### Scenario: A change-feed notification is delivered as an ordered event
- **WHEN** the `CanvasChangeFeed` flushes a notification for a subscribed canvas
- **THEN** the stream delivers it as an ordered event carrying its covering seq range, in seq order relative to other events

### Requirement: The session attaches the live canvasOps@2 surface with no user-only or engine-only op
A booted orchestrator session SHALL expose a tool index equal to the live `canvasOps@2` registry (`CANVAS_OPS_TOOLS`), and that surface SHALL contain no user-only op (disposition, adjudicate, expand/collapse, select, pin/clear) and no engine-only op (project, invalidate, carry, order). The adapter SHALL construct the in-process `canvasOps@2` MCP server alongside the session so the descriptors the tool index names are the ones the model can call.

#### Scenario: The attached tool index is exactly the canvasOps@2 registry
- **WHEN** a session is booted and its tool index enumerated
- **THEN** the index names equal `CANVAS_OPS_TOOLS`' names in order, and none of the user command vocabulary or engine command vocabulary appears

#### Scenario: The adapter builds the MCP server without spawning a model
- **WHEN** `attachOrchestratorSession` is called with a backend and a fake SDK loader
- **THEN** it returns the core session and an in-process MCP server registering exactly the canvasOps@2 tool set, with no model invoked
