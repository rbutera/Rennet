# repo-map-delta-pass specification

## Purpose

Rennet keeps the default-branch Repo Map current with deterministic incremental passes, composes non-default bases as overlays, and updates model-derived knowledge outside the review's critical path.

## Requirements

### Requirement: Baseline movement is detected and coalesced to the newest OID

Rennet SHALL detect when the resolved default-branch OID moves and enqueue a deterministic delta pass for the **newest** OID only. Detection SHALL be event-driven (a debounced watch of the resolved ref) rather than age-based. A burst of several advances SHALL coalesce to a single pass at the tip; intermediate OIDs SHALL NOT be chased.

#### Scenario: A merge train collapses to one pass

- **WHEN** the default-branch ref advances several times within the debounce window
- **THEN** exactly one delta pass is enqueued, for the tip OID
- **AND** no snapshot is built for any intermediate OID

#### Scenario: No movement, no work

- **WHEN** the watcher fires but the re-resolved base OID equals the stored `manifest.baseOid`
- **THEN** no delta pass is enqueued

### Requirement: The delta pass is deterministic and byte-equivalent to a full build

The delta pass SHALL rebuild only the changed-path closure. It SHALL reuse unchanged blob shards, re-extract changed blobs, and advance the store atomically. The resulting snapshot SHALL be byte-identical to a clean full build at the same OID. No model turn SHALL enter the delta pass.

#### Scenario: Incremental equals full

- **WHEN** a delta pass advances the snapshot from `old` to `new`
- **THEN** the stored snapshot at `new` is byte-identical to a clean full build at `new`

#### Scenario: A crash mid-pass leaves the prior snapshot intact

- **WHEN** a delta pass is interrupted before its final atomic advance
- **THEN** the previously stored snapshot remains fully readable and unchanged

### Requirement: A review never blocks on the delta pass

Reviews SHALL proceed on the current stored snapshot via the fail-closed gate while a delta pass is queued or running; there SHALL be no lock a review waits on. Correctness SHALL be guaranteed by the on-open path (which builds synchronously at the review's base OID if the store is not yet current), not by the proactive pass.

#### Scenario: Review opens while a pass is in flight

- **WHEN** a review is opened while a delta pass is queued or running
- **THEN** the review reads the current snapshot through `loadFresh` without waiting for the pass
- **AND** if the review's base OID is not yet in the store, the on-open build serves it rather than blocking

### Requirement: A non-default base is served by base + overlay composition

A review against a non-default base SHALL use the default-branch map as the **base** and a per-non-default-base **overlay** on top, rather than a full independent snapshot or a per-branch tracked map. The overlay SHALL be the deterministic `defaultOid..nonDefaultBaseOid` delta (via the same incremental machinery), stored at `~/.rennet/projects/<esc>/overlays/<non-default-base-oid>/`, and reused when fresh. A merged read SHALL apply **overlay-wins** precedence per shard key, with a deletion on the non-default base represented as an overlay tombstone so the merged read omits it. The merged view's composite `(base, overlay)` fingerprint SHALL be the effective snapshot id the review pins to.

#### Scenario: Merged view equals a full build at the non-default base

- **WHEN** a review runs against a non-default base and the base+overlay are composed
- **THEN** the merged structural view is byte-equivalent to a clean full build at the non-default-base OID
- **AND** a path deleted on the non-default base is omitted from the merged read

#### Scenario: Overlay re-derives when the base advances

- **WHEN** the default-branch base advances (via a delta pass) under an open non-default-base review
- **THEN** the overlay is treated as stale on its `(defaultOid, nonDefaultBaseOid)` pair and re-derived against the new base

### Requirement: An uncapped LLM knowledge pass runs off the same trigger and never blocks review

The baseline-advance trigger SHALL also run a knowledge-enrichment pass. It SHALL invalidate statements whose evidence anchors intersect the diff, then use an uncapped model pass to assess the invalidated statements and find new statements in the affected scope maps. Untouched knowledge SHALL stay pinned to its original evidence. A generator, schema, guideline, or accumulation-threshold change SHALL trigger a full rollup. The pass SHALL debounce and coalesce work to the newest OID. It SHALL NEVER block a review. Reviews proceed on the current snapshot and surviving knowledge. The `ContextManifest` SHALL disclose statements withheld as `invalidated-pending`. Only this pass, not the structural pass, may invoke a model.

#### Scenario: A review proceeds while knowledge is re-enriching

- **WHEN** a knowledge delta pass is running after a baseline advance and a review reads context
- **THEN** the review proceeds on the current snapshot and the surviving (non-invalidated) knowledge without waiting
- **AND** any statement withheld as invalidated-pending is disclosed in the ContextManifest rather than silently omitted

#### Scenario: Untouched knowledge is not re-run

- **WHEN** a knowledge delta pass runs for a diff that does not intersect a statement's evidence anchors
- **THEN** that statement stays pinned to its original evidence and is not re-adjudicated
