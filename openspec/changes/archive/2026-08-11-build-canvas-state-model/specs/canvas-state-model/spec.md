## ADDED Requirements

### Requirement: A canvas is a pure four-layer projection that rebuilds byte-identically
A `Canvas` SHALL be a projection keyed `(reviewId, patchsetId, angle)` over four layers — L0 substrate (deterministic ingest), L1 analysis (admitted RSP documents, deterministically placed), L2 disposition (the review's dispositions), L3 annotation (the canvas-op event stream) — assembled by `buildCanvas` as a pure function of admitted documents, the decomposition, the review's dispositions, and the canvas-op events. Rebuilding the canvas by replaying the same events SHALL produce a byte-identical result.

#### Scenario: A canvas rebuilds byte-identically from event replay
- **WHEN** a canvas is built, then rebuilt from the same admitted documents, decomposition, dispositions, and replayed canvas-op events
- **THEN** the two canvases' canonical digests are equal

### Requirement: L1 placement is a deterministic pure function; identity is derived, decisions never capped
`projectAnalysis` SHALL place admitted RSP documents onto canvas elements as a pure function of the admitted document plus the deterministic ordering rules: the decisions canvas groups decisions into cohorts ordered by their anchored chunk's decomposition reading-order position and is never capped; the sequence canvas is the admitted reading order. Every element's `elementKey` SHALL be derived from `docId` + anchor; canvas elements SHALL mint no identity. Fleet agents never touch a canvas.

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
`CanvasChangeFeed` SHALL publish notifications keyed `(reviewId, canvasId, elementKey)` carrying a covering `seqRange`, conflating per key so a conflated notification names the seq range it covers, never publishing a private row and never carrying a raw event. Buffers SHALL be bounded; a consumer that misses a notification SHALL detect the seq gap and re-query the projection.

#### Scenario: Conflation carries its range
- **WHEN** several changes to one element key are published and flushed
- **THEN** one notification is delivered whose `seqRange` spans from the first to the last seq

#### Scenario: A missed notification is recovered by re-query
- **WHEN** a consumer misses earlier notifications and the next delivered notification's `seqRange.from` exceeds its last-seen seq plus one
- **THEN** the consumer detects the gap and re-queries the projection from the store

#### Scenario: Private rows are never published
- **WHEN** a private change is published
- **THEN** no notification is delivered for it
