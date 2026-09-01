## Purpose

Define the bounded, typed evidence contract for the round-report classifier: what enters the classification turn, what may come back, and how overflow fails — so the report between a coding round and the core boards is fast, bounded, and truthful.

## ADDED Requirements

### Requirement: The evidence manifest is canonical, stable, and byte-bounded

The classifier input SHALL be a canonically ordered evidence manifest with a stable id per evidence unit. The system SHALL measure the complete serialized manifest in UTF-8 bytes against a declared limit: at or under the limit the manifest is sent intact; over the limit produces a typed local failure before any provider call. The system SHALL NOT truncate, split, summarize, or send malformed or partial JSON to fit the budget.

#### Scenario: Manifest exactly at the byte limit

- **WHEN** the serialized manifest measures exactly the declared UTF-8 byte limit, including multibyte characters at the boundary
- **THEN** the manifest is sent intact

#### Scenario: Manifest one byte over the limit

- **WHEN** the serialized manifest measures one byte over the declared limit
- **THEN** a typed overflow failure is produced locally, zero provider calls are made, and the failure surfaces through the durable round-failure path

### Requirement: Evidence is a discriminated union that never invents line anchors

Text hunks and non-line changes SHALL be represented by a discriminated evidence union covering at least binary changes, mode changes, and pure renames. Mixed changes SHALL remain lossless across variants, and no variant SHALL fabricate a line anchor for a change that has none.

#### Scenario: Round lands a rename plus a mode change

- **WHEN** the evidence for a round includes a pure rename and a mode-only change
- **THEN** each is represented by its own union variant with no invented line anchor, and no evidence is dropped

### Requirement: Evidence partitions into exactly one bucket

Every evidence id in the manifest SHALL appear in exactly one ask bucket or the explicit `beyond asks` bucket of the classification. Unknown, missing, or duplicate evidence ids in the classifier output SHALL be rejected before persistence. This makes the report's attribution exhaustive and non-overlapping, closing #726's auditability requirement inside the same contract.

#### Scenario: Classifier omits an evidence unit

- **WHEN** the decoded classification fails to place one manifest evidence id in any bucket
- **THEN** the output is rejected before persistence and the failure surfaces through the durable round-failure path

#### Scenario: Classifier attributes one hunk twice

- **WHEN** the decoded classification places the same evidence id in two buckets
- **THEN** the output is rejected before persistence

### Requirement: Classifier output is capped and validated before persistence

The system SHALL set an explicit provider output-token cap, SHALL reject an oversized raw response before parsing, and SHALL enforce decoded entry and cardinality limits before persistence. Raw-size rejection SHALL be enforced at the harness transport boundary for both the Claude and Codex adapters, before structured-output decoding — not solely in core, whose inputs are already decoded. A cap failure SHALL NOT expand into an additional classifier turn, and SHALL surface through the durable round-failure path rather than leaving the client waiting.

#### Scenario: Provider returns an oversized raw response

- **WHEN** the raw classifier response exceeds the declared output cap
- **THEN** it is rejected before parsing, no retry turn is spawned by the cap failure, and the round records a typed durable failure

### Requirement: Crash recovery repeats the call, not the projection

The classifier is side-effect-free before durable projection, so after a crash between provider response and projection the system MAY repeat the provider call. The system SHALL guarantee exactly one durable report projection per round; it SHALL NOT claim exactly-once remote invocation.

#### Scenario: Crash after response, before projection

- **WHEN** the process crashes after receiving a classifier response but before the durable projection is written
- **THEN** recovery may re-run the classification and exactly one durable report projection exists afterward
