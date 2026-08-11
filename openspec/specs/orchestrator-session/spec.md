# orchestrator-session Specification

## Purpose
TBD - created by archiving change build-orchestrator-session. Update Purpose after archive.
## Requirements
### Requirement: The orchestrator boots with a lean map-not-container primer
The system SHALL assemble a deterministic, versioned primer for a fresh orchestrator session as a MAP of the review, not a container of it. The primer SHALL contain B1 review identity (workspace/repo, reviewId, patchsetId, lineage position, mode), B2 freshness verdicts (one line per repo), B3 count-level canvas state (per canvas: element / cohort / disposition-coverage / residue counts — counts only, never contents, and the decisions list SHALL NOT be inlined), B4 the protocol card, B5 a tool index derived from the live `canvasOps@2` surface (names + when-to-use one-liners, schemas deferred), and B6 the run-ledger headline. The assembled primer SHALL be ≤ 4 KB.

#### Scenario: A fresh session answers orientation from the bootstrap without a tool call
- **WHEN** a fresh session boots with a primer for a review whose canvases carry dispositioned and undispositioned paths
- **THEN** the primer is ≤ 4 KB and its B3 section states, per canvas, the counts that answer "where are we" and "what have you not looked at yet" (unread / disposition-coverage), so the question is answerable from the primer text with no tool call

#### Scenario: Count-level state never inlines contents
- **WHEN** the primer's B3 canvas state is assembled for a review with many decisions
- **THEN** it carries the decision COUNT and never the decision bodies or titles — the decisions list is reachable via the tool surface, not inlined

### Requirement: Primer assembly is deterministic and the card is a versioned template
Primer assembly SHALL be a pure function of the review state: the same state SHALL produce identical bytes and an identical digest. The primer's SHA-256 digest SHALL be recorded in the orchestrator session's provenance. The protocol card SHALL be a versioned base instruction: a fixed template with a version identifier, matched byte-for-byte, carrying the four-actor contract, the two product principles (logical ordering; roll-up/zoom), what the orchestrator can never do, and the ask protocol (can-ask / how-to-ask / answer-shapes) including "never answer about the base branch or unexamined code from recall — retrieve or ask first".

#### Scenario: Same state assembles to the same bytes and digest
- **WHEN** `assemblePrimer` is called twice with equal inputs
- **THEN** the two manifests carry identical `text`, identical `bytes`, and an identical `digest`

#### Scenario: The card matches its versioned template and the digest lands in provenance
- **WHEN** a session boots
- **THEN** the primer's card section equals the versioned `PROTOCOL_CARD` template, the card carries its version identifier, and the session's provenance records the primer digest and versions

### Requirement: User acts are pushed as structured events into the orchestrator's context
The system SHALL push user acts into the orchestrator's context as structured events: `{selected}` (anchor + element summary), `{disposed}` (anchor + type + body), `{proposal-adjudicated}` (proposalId + outcome + edited payload — dismissals teach), and `{viewing}` (canvas + cohort — cheap deixis). The system SHALL NOT collect or derive dwell or pace metrics. Every delivered event SHALL be appended to the open-assembled-prompt panel and be inspectable byte-for-byte.

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

### Requirement: The stream consumes the change feed and batches deixis under an injected clock (R35, not Rx)
The context-update stream SHALL NOT be an Rx pipeline. It SHALL consume issue #10's post-commit `CanvasChangeFeed` plus direct user-act events, delivered in store/seq order; consumers MAY coalesce but SHALL NOT reorder. The `{viewing}` deixis batching SHALL be a hand-rolled batcher under an injected clock with a bounded buffer that coalesces by canvas key (later viewing replaces earlier) and is never silent: a coalesced delivery SHALL state the seq range it covers.

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

