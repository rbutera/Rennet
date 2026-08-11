## ADDED Requirements

### Requirement: Every document carries a universal envelope with a preserved extension bag
Every RSP document SHALL carry the envelope fields `rsp`, `docType`, `schemaVersion`, `patchsetId`, `provenance`, `body`, and `x`, MAY carry an adapter-minted `docId`, `reviewId`, `projectSnapshotId`, and `supersedes`, and SHALL preserve unknown keys in `x` verbatim through canonical serialisation. The `docId` SHALL be minted by the adapter, never by the agent.

#### Scenario: Unknown extension keys survive a round-trip
- **WHEN** a document with unknown keys under `x` is canonically serialised and re-parsed
- **THEN** every unknown `x` key is preserved with its value unchanged

#### Scenario: Canonical serialisation is deterministic
- **WHEN** a value is canonically serialised
- **THEN** object keys are recursively sorted, arrays keep their order, and the output is 2-space-indented with LF newlines

### Requirement: The provenance block is complete and keeps reported and derived cost distinct
The provenance block SHALL carry `harness`, `harnessVersion`, `adapterVersion`, `model`, `modelReportedBy`, `tier`, `route`, `runId`, `inputDigest`, a three-layer capability snapshot for `structuredOutput` and `perCallModelSelection`, token usage, and both `reportedUsd` and `derivedUsd` as independent nullable fields that are never merged.

#### Scenario: A capability with no session evidence
- **WHEN** a capability is present with `implementedByAdapter` true but `advertisedByHarness` and `availableInSession` false
- **THEN** the snapshot records exactly those three layers and the document is labelled as produced under that capability state

### Requirement: The anchor grammar is narrow and side-qualified
An anchor SHALL match `rennet:` kind `/` id with an optional span or JSON-Pointer fragment, an optional side, and an optional proposal. The `kind` SHALL be one of the closed set (`hunk`, `file`, `symbol`, `chunk`, `patchset`, `reach`, `doc`, `noisegroup`, `spec`, `requirement`), a span SHALL be a 1-based line range within the anchored unit, and a side SHALL be one of `additions`, `deletions`, `context`.

#### Scenario: A side-qualified span parses
- **WHEN** `rennet:hunk/h_2MMD02#L14-L31@additions` is parsed
- **THEN** it yields kind `hunk`, id `h_2MMD02`, span lines 14–31, and side `additions`

#### Scenario: An unknown kind is rejected at parse time
- **WHEN** `rennet:banana/x` is parsed
- **THEN** parsing fails with an unknown-kind reason

### Requirement: Anchor resolution is total with exactly four outcomes and fails closed on ambiguity
Resolving an anchor against a patchset's offered manifest SHALL return exactly one of `resolved`, `unresolved`, `superseded`, or `orphaned`. A `superseded` outcome SHALL name its successor and MAY carry read-state forward; an `orphaned` outcome SHALL NOT carry read-state forward; and an ambiguous or terminated lineage SHALL orphan rather than supersede.

#### Scenario: A forward-mapped id supersedes
- **WHEN** an id absent from the current manifest maps forward through a non-ambiguous lineage
- **THEN** resolution is `superseded`, names the successor, and carries state

#### Scenario: Ambiguous lineage fails closed
- **WHEN** an id maps forward through an ambiguous lineage
- **THEN** resolution is `orphaned` and does not carry state
