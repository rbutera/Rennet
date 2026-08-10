# repo-map-delta-pass

Proactive refresh as the reference branch moves — a model-free structural pass AND a bounded LLM knowledge-enrichment pass off one shared trigger — plus base+overlay composition for reviews against a non-default base, without ever blocking or gating a review. Builds on the wave-1 incremental machinery (`planIncrementalSymbols`, atomic `store.advance`) and the fail-closed on-open gate. Mirrors codeindexer.dev's per-changed incremental reindex; the structural pass stays strictly model-free, the knowledge pass is the model-backed half.

## ADDED Requirements

### Requirement: Baseline movement is detected and coalesced to the newest OID

Rennet SHALL detect when the resolved default-branch OID moves and enqueue a deterministic delta pass for the **newest** OID only. Detection SHALL be event-driven (a debounced watch of the resolved ref) rather than age-based. A burst of several advances SHALL coalesce to a single pass at the tip; intermediate OIDs SHALL NOT be chased.

#### Scenario: a merge train collapses to one pass

- **WHEN** the default-branch ref advances several times within the debounce window
- **THEN** exactly one delta pass is enqueued, for the tip OID
- **AND** no snapshot is built for any intermediate OID

#### Scenario: no movement, no work

- **WHEN** the watcher fires but the re-resolved base OID equals the stored `manifest.baseOid`
- **THEN** no delta pass is enqueued

### Requirement: The delta pass is deterministic and byte-equivalent to a full build

The delta pass SHALL rebuild only the changed-path closure using the wave-1 incremental path (reuse unchanged blobs' shards verbatim, re-extract only changed blobs) and SHALL advance the store atomically. The resulting snapshot SHALL be byte-identical to a clean full build at the same OID. No model turn SHALL enter the delta pass.

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
- **AND** if the review's base OID is not yet in the store, the on-open build serves it rather than blocking

### Requirement: A non-default base is served by base + overlay composition

A review against a non-default base SHALL use the default-branch map as the **base** and a per-non-default-base **overlay** on top, rather than a full independent snapshot or a per-branch tracked map. The overlay SHALL be the deterministic `defaultOid..nonDefaultBaseOid` delta (via the same incremental machinery), stored at `~/.rennet/projects/<esc>/overlays/<non-default-base-oid>/`, and reused when fresh. A merged read SHALL apply **overlay-wins** precedence per shard key, with a deletion on the non-default base represented as an overlay tombstone so the merged read omits it. The merged view's composite `(base, overlay)` fingerprint SHALL be the effective snapshot id the review pins to.

#### Scenario: merged view equals a full build at the non-default base

- **WHEN** a review runs against a non-default base and the base+overlay are composed
- **THEN** the merged structural view is byte-equivalent to a clean full build at the non-default-base OID
- **AND** a path deleted on the non-default base is omitted from the merged read

#### Scenario: overlay re-derives when the base advances

- **WHEN** the default-branch base advances (via a delta pass) under an open non-default-base review
- **THEN** the overlay is treated as stale on its `(defaultOid, nonDefaultBaseOid)` pair and re-derived against the new base

### Requirement: A bounded LLM knowledge pass runs off the same trigger and never blocks review

On the same baseline-advance trigger, a knowledge-enrichment pass SHALL run: knowledge statements whose evidence anchors intersect the diff SHALL be invalidated, then a bounded medium-model pass over the diff, the invalidated statements, and the affected scope maps SHALL re-adjudicate each and mine net-new statements; untouched knowledge SHALL stay pinned to its original evidence. A full heavy-model re-rollup SHALL run only on a generator, schema, or guideline change or an accumulation threshold. The pass SHALL be budget-capped, debounced, and coalesced to the newest OID. It SHALL NEVER block a review: reviews proceed on the current snapshot plus surviving knowledge, and statements withheld as invalidated-pending SHALL be disclosed in the ContextManifest (R29), never silently dropped. The model SHALL enter only this pass, never the structural pass.

#### Scenario: a review proceeds while knowledge is re-enriching

- **WHEN** a knowledge delta pass is running after a baseline advance and a review reads context
- **THEN** the review proceeds on the current snapshot and the surviving (non-invalidated) knowledge without waiting
- **AND** any statement withheld as invalidated-pending is disclosed in the ContextManifest rather than silently omitted

#### Scenario: untouched knowledge is not re-run

- **WHEN** a knowledge delta pass runs for a diff that does not intersect a statement's evidence anchors
- **THEN** that statement stays pinned to its original evidence and is not re-adjudicated
