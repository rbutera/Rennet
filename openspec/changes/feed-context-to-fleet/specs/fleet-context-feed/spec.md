# fleet-context-feed

## Purpose

The deterministic, byte-budgeted context assembly (#30) stops being a recorded-but-discarded artifact and becomes what the fleet is literally sent: every fleet agent's real prompt carries the assembly as a labelled layer, shared across seats, never gating a turn.

## ADDED Requirements

### Requirement: Every fleet seat's prompt carries the assembled context as its labelled context layer

When an assembled context is available for a review, the system SHALL thread its exact text into the prompt of every fleet seat turn — hypothesis, decomposition, ordering, narration (via the pipeline), finding (both dual seats), noise, and decisions — as the `context` layer of the existing layered prompt assembly, positioned in the fixed layer order and framed with the standard layer label so the sent text remains attributable. The layer body SHALL be byte-identical to the recorded assembly text.

#### Scenario: A seat prompt contains the assembly verbatim

- **WHEN** a seat runner assembles its prompt with an assembled context supplied
- **THEN** the assembled prompt contains a labelled `context` layer whose body is byte-identical to the assembly text, and the sha256 of that body equals the manifest's `assembledPromptDigest`

#### Scenario: Both dual finding seats receive the same shared assembly

- **WHEN** the dual finding review runs a Claude seat and a Codex seat
- **THEN** both seats' prompts carry the identical context layer, so the cross-model reconcile compares two minds over the same declared context

### Requirement: The orchestrator turn receives the assembled context

The system SHALL append the assembled context to the orchestrator turn's system-prompt append (after the primer), framed as a labelled context block, so the orchestrator reasons over the same deterministic, byte-budgeted context as the seats rather than only ambient harness reads.

#### Scenario: The orchestrator append carries the labelled context block

- **WHEN** a live orchestrator turn runs with an assembled context available
- **THEN** the system-prompt append contains the primer followed by a labelled context block byte-identical to the assembly text

### Requirement: An absent assembly never changes or blocks a turn

The feed SHALL be strictly additive and gate-free (Rule Zero). When no assembly is available (no snapshot, failed composition, unreadable store), every seat and orchestrator turn SHALL run with a prompt byte-identical to the prompt it assembles today, and no turn SHALL ever be refused, delayed, or degraded because context could not be fed.

#### Scenario: No assembly, byte-identical prompt

- **WHEN** a seat runner assembles its prompt with no assembled context supplied
- **THEN** the assembled prompt is byte-identical to the prompt produced before this capability existed

#### Scenario: A capture failure does not stop the review

- **WHEN** the context capture fails for a review
- **THEN** the fleet runs unfed and the review completes exactly as today, with the manifest honestly absent

### Requirement: The deterministic-ordering and byte-budget contract is carried into the send

The fed context SHALL be the output of the deterministic assembly: identical inputs produce a byte-identical fed layer, document order is the declared composition order, and every budget cut inside the assembly remains visibly marked in the sent text. A prompt-level byte budget MAY additionally drop the whole context layer, and such a drop SHALL be visible in the runner's layer contributions and recorded — never a silent omission and never a refusal of the turn.

#### Scenario: Determinism reaches the wire

- **WHEN** two runs assemble and feed context from identical inputs
- **THEN** the two sent context layers are byte-identical

#### Scenario: A budget-dropped layer is metered and reported, and the turn still runs

- **WHEN** a seat's prompt byte-budget cannot fit the context layer
- **THEN** the layer is dropped visibly (reported in the layer contributions and the send record), lower-priority layers follow the fixed drop order, and the turn is sent anyway

### Requirement: The fed text is the digest-verified captured assembly, never a fresh read of mutable guidance

The send path SHALL source the context text from the persisted capture, verified against the manifest's `assembledPromptDigest`, so the fleet is fed exactly the recorded bytes. On a verification mismatch or a missing text artifact the system SHALL re-capture (rebuild and re-persist both manifest and text) so the manifest always describes the bytes the fleet actually gets — the manifest never describes bytes the fleet does not receive.

#### Scenario: The panel and the send agree

- **WHEN** a review's fleet runs and its manifest panel is inspected
- **THEN** the digest of the fed context layer equals the persisted manifest's `assembledPromptDigest`

#### Scenario: A stale text artifact is superseded, not served

- **WHEN** the persisted text fails digest verification against its manifest
- **THEN** the assembly is rebuilt deterministically, both artifacts are re-persisted, and the rebuilt text is what the fleet is fed
