# canvas-state-model Specification

## Purpose
Defines the deterministic four-layer canvas projection, its event replay rules, and its exact-lineage carry behavior.
## Requirements
### Requirement: A canvas is a pure four-layer projection that rebuilds byte-identically
A `Canvas` SHALL be a projection keyed `(reviewId, patchsetId, angle)` over four layers. L0 contains deterministic ingest, L1 contains deterministically placed admitted RSP documents, L2 contains the review's dispositions, and L3 contains the canvas-op event stream. `buildCanvas` SHALL assemble those layers as a pure function of admitted documents, the decomposition, the review's dispositions, and the canvas-op events. Replaying the same events SHALL produce a byte-identical canvas.

#### Scenario: A canvas rebuilds byte-identically from event replay
- **WHEN** a canvas is built, then rebuilt from the same admitted documents, decomposition, dispositions, and replayed canvas-op events
- **THEN** the two canvases' canonical digests are equal

### Requirement: L1 placement is a deterministic pure function; identity is derived, decisions never capped
`projectAnalysis` SHALL place admitted RSP documents onto canvas elements as a pure function of the document and deterministic ordering rules. The decisions canvas SHALL group decisions into uncapped cohorts ordered by the anchored chunk's reading-order position. The sequence canvas SHALL use the admitted reading order. Every `elementKey` SHALL derive from `docId` and anchor. Canvas elements SHALL mint no identity, and fleet agents SHALL never modify a canvas.

#### Scenario: Same admitted docs projected twice yields an identical canvas
- **WHEN** the same admitted documents are projected twice against the same decomposition
- **THEN** the two analysis layers are deep-equal (placement determinism)

#### Scenario: Decisions are never capped
- **WHEN** a decision.record admits five hundred decisions in one cohort
- **THEN** all five hundred are placed, none dropped or truncated

### Requirement: L2 is user-sovereign, enforced structurally
No agent-reachable path SHALL write L2. The orchestrator canvas op vocabulary SHALL contain no disposition-write op, and orchestrator dispatch SHALL structurally be unable to emit a disposition event. A disposition reaches L2 only through a user command (a direct disposition or accepting a proposal).

#### Scenario: No orchestrator op can write L2
- **WHEN** the orchestrator canvas op vocabulary and each op's effects are inspected
- **THEN** none is a disposition/L2 write and the vocabulary contains no disposition command

### Requirement: L3 annotations are session-scoped
`foldCanvas` SHALL keep L3 annotations for the review session and, on `SessionEnded`, drop every unpinned annotation while pinned annotations survive.

#### Scenario: Session end clears unpinned L3 and keeps pinned
- **WHEN** a session ends with one pinned and one unpinned annotation
- **THEN** the pinned annotation survives and the unpinned one is gone

### Requirement: Successor-canvas carry is exact-lineage only
On a new patchset `carrySuccessorDispositions` SHALL carry a disposition forward only where the successor patchset has a file at the same path whose patch is byte-identical; any change fails closed and the element arrives unread.

#### Scenario: A changed file's approval does not carry, an unchanged file's does
- **WHEN** a successor patchset changes one approved file and leaves another byte-identical
- **THEN** the unchanged file's approval carries and the changed file's does not

### Requirement: The canvas change feed is a bounded invalidation hint whose truth stays the store
`CanvasChangeFeed` SHALL publish notifications keyed by `(reviewId, canvasId, elementKey)` with a covering `seqRange`. It SHALL conflate notifications per key so each result names the sequence range it covers. It SHALL publish neither private rows nor raw events. Buffers SHALL be bounded. A consumer that misses a notification SHALL detect the sequence gap and query the projection again.

#### Scenario: Conflation carries its range
- **WHEN** several changes to one element key are published and flushed
- **THEN** one notification is delivered whose `seqRange` spans from the first to the last seq

#### Scenario: A missed notification is recovered by re-query
- **WHEN** a consumer misses earlier notifications and the next delivered notification's `seqRange.from` exceeds its last-seen seq plus one
- **THEN** the consumer detects the gap and re-queries the projection from the store

#### Scenario: Private rows are never published
- **WHEN** a private change is published
- **THEN** no notification is delivered for it
