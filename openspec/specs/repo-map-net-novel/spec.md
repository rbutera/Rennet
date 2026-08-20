# repo-map-net-novel specification

## Purpose

Rennet classifies a patchset against its pinned effective baseline and requires every model-backed novelty judgment to cite the snapshot or knowledge that supports it.

## Requirements

### Requirement: The diff pack pins to the baseline it was computed against

The `Patchset` SHALL carry a `projectSnapshotId` field identifying the exact snapshot used to compute the diff pack. This is the base map fingerprint for a default-base review and the composite `(base, overlay)` fingerprint for a non-default-base review. The deterministic novelty ledger SHALL pin to that id. A request whose snapshot does not match SHALL return a typed stale refusal instead of using a different baseline.

#### Scenario: A mismatched baseline is refused

- **WHEN** a novelty classification is requested for a patchset whose `projectSnapshotId` does not match a fresh, intact stored snapshot
- **THEN** the request yields a typed refusal, never a ledger computed against the wrong baseline

### Requirement: Net-novelty is classified against the effective (merged) baseline

For a non-default-base review, the deterministic ledger SHALL classify against the merged base+overlay view, so `novel` / `extends` / `conforms` is relative to the baseline the review actually targets, not the default branch alone.

#### Scenario: A non-default-base review classifies against its effective baseline

- **WHEN** a change is classified for a review whose base is a non-default branch
- **THEN** an item already present in the merged base+overlay view is not reported as net-novel

### Requirement: Baseline advance re-adjudicates only classification-changed items

When the baseline advances while a review is open, the novelty section SHALL become potentially invalid. The deterministic ledger SHALL run again against the new effective snapshot. Only entries whose classification changed SHALL be marked for model-backed re-adjudication. Prior model-backed output SHALL remain visible until regeneration succeeds, and regeneration SHALL NOT run automatically.

#### Scenario: Unchanged classifications are not re-adjudicated

- **WHEN** the baseline advances and an entry's deterministic classification is unchanged
- **THEN** that entry is not marked for model-backed re-adjudication

#### Scenario: A flipped classification is reported

- **WHEN** the baseline advances and an entry's classification changes (e.g. `conforms` becomes `novel`)
- **THEN** that entry is marked for model-backed re-adjudication, while its prior output stays visible until regeneration succeeds

### Requirement: Baseline material is fed before the diff pack

The context pack fed to the review agents and orchestrator SHALL present baseline material (merged snapshot shards via `context.map`, primer) before the diff pack and its novelty section, so net-novelty is judged with the baseline in hand.

#### Scenario: Feed order is baseline-first

- **WHEN** a context pack is assembled for review
- **THEN** the baseline material precedes the diff pack and its novelty section

### Requirement: Every net-novel judgment cites its baseline evidence

The model-backed net-novel output schema SHALL require every judgment to cite a `(projectSnapshotId, shardRef)` pair or a knowledge-statement id. A novelty claim with no citation SHALL validate only as a labelled hypothesis, never as an asserted fact.

#### Scenario: An uncited novelty claim is a hypothesis

- **WHEN** a model-backed output asserts that an item is net-novel without a citation
- **THEN** it fails validation as a fact and is admitted only as a labelled hypothesis

#### Scenario: A cited judgment validates as a finding

- **WHEN** a model-backed output asserts net novelty and cites a resolvable `(projectSnapshotId, shardRef)` or knowledge-statement id
- **THEN** it validates as a net-novel finding
