# repo-map-delta-pass

Proactive, deterministic refresh of the ProjectSnapshot as the reference branch moves, so a review never pays a cold rebuild — without ever blocking or gating a review. Builds on the wave-1 incremental machinery (`planIncrementalSymbols`, atomic `store.advance`) and the fail-closed on-open gate.

## ADDED Requirements

### Requirement: Baseline movement is detected and coalesced to the newest OID

Rennet SHALL detect when the resolved default-branch OID moves and enqueue a deterministic delta pass for the **newest** OID only. Detection SHALL be event-driven (a debounced watch of the resolved ref) rather than age-based. A burst of several advances (a merge train) SHALL coalesce to a single pass at the tip; intermediate OIDs SHALL NOT be chased.

#### Scenario: a merge train collapses to one pass

- **WHEN** the default-branch ref advances several times within the debounce window
- **THEN** exactly one delta pass is enqueued, for the tip OID
- **AND** no snapshot is built for any intermediate OID

#### Scenario: no movement, no work

- **WHEN** the watcher fires but the re-resolved base OID equals the stored `manifest.baseOid`
- **THEN** no delta pass is enqueued

### Requirement: The delta pass is deterministic and byte-equivalent to a full build

The delta pass SHALL rebuild only the changed-path closure using the wave-1 incremental path (reuse unchanged blobs' shards verbatim, re-extract only changed blobs) and SHALL advance the store atomically. The resulting snapshot SHALL be byte-identical to a clean full build at the same OID. No model turn SHALL enter the delta pass (the snapshot stays model-free, R30/R54).

#### Scenario: incremental equals full

- **WHEN** a delta pass advances the snapshot from `old` to `new`
- **THEN** the stored snapshot at `new` is byte-identical to a clean full build at `new`

#### Scenario: a crash mid-pass leaves the prior snapshot intact

- **WHEN** a delta pass is interrupted before its final atomic advance
- **THEN** the previously stored snapshot remains fully readable and unchanged

### Requirement: A review never blocks on the delta pass

Reviews SHALL proceed on the current stored snapshot via the fail-closed gate while a delta pass is queued or running; there SHALL be no lock a review waits on. Correctness SHALL be guaranteed by the on-open path (which builds synchronously at the review's base OID if the store is not yet current), not by the proactive pass.

#### Scenario: review opens while a pass is in flight

- **WHEN** a review is opened while a delta pass is queued or running
- **THEN** the review reads the current snapshot through `loadFresh` without waiting for the pass
- **AND** if the review's base OID is not yet in the store, the on-open build serves it rather than blocking on the background pass
