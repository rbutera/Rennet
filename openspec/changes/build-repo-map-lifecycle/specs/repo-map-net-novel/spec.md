# repo-map-net-novel

Coupling the per-diff context pack to the baseline Repo Map so the review can tell what is genuinely net-novel in a changeset versus an instance of an existing pattern. Builds on the wave-1 deterministic Stage-1 novelty ledger (`classifyNovelty` / `NoveltyLedgerReader`).

## ADDED Requirements

### Requirement: The diff pack pins to the baseline it was computed against

The `Patchset` SHALL carry a `projectSnapshotId` field (Contracts §3.1) identifying the exact snapshot the diff pack was computed against. The deterministic novelty ledger SHALL pin on that id: a ledger SHALL be valid only for the snapshot it names, and a request whose snapshot does not match SHALL be refused as stale rather than served against a mismatched baseline (Rule 75, the "never consume stale context" circuit).

#### Scenario: a mismatched baseline is refused

- **WHEN** a novelty classification is requested for a patchset whose `projectSnapshotId` does not match a fresh, intact stored snapshot
- **THEN** the request yields a typed refusal, never a ledger computed against the wrong baseline

### Requirement: Baseline advance re-adjudicates only classification-changed items

When the baseline advances while a review is open, the novelty section SHALL be treated as potentially-invalid (R29): the deterministic ledger SHALL be re-run against the new snapshot, and only entries whose classification (`novel` / `extends` / `conforms`) changed SHALL be marked for Stage-2 re-adjudication. Prior model-backed output SHALL remain visible until model-backed regeneration succeeds, and regeneration SHALL NOT be automatic.

#### Scenario: unchanged classifications are not re-adjudicated

- **WHEN** the baseline advances and an entry's deterministic classification is unchanged between the old and new snapshot
- **THEN** that entry is not marked for Stage-2 re-adjudication

#### Scenario: a flipped classification is surfaced

- **WHEN** the baseline advances and an entry's classification changes (e.g. `conforms` becomes `novel`)
- **THEN** that entry is marked for Stage-2 re-adjudication, while its prior output stays visible until regeneration succeeds

### Requirement: Baseline material is fed before the diff pack

The context pack fed to the review agents and orchestrator SHALL present baseline material (snapshot shards via `context.map`, primer) before the diff pack and its novelty section, so net-novelty is judged with the baseline in hand.

#### Scenario: feed order is baseline-first

- **WHEN** a context pack is assembled for review
- **THEN** the baseline material precedes the diff pack and its novelty section

### Requirement: Every net-novel judgment cites its baseline evidence

The Stage-2 net-novel output schema SHALL require every net-novel judgment to cite a `(projectSnapshotId, shardRef)` or a knowledge-statement id. A novelty claim with no citation SHALL validate only as a labelled hypothesis, never as an asserted fact. (The schema and validator ship in v1; the model that emits cited judgments runs on the deferred knowledge layer.)

#### Scenario: an uncited novelty claim is a hypothesis

- **WHEN** a Stage-2 output asserts an item is net-novel without a citation
- **THEN** it fails validation as a fact and is admitted only as a labelled hypothesis

#### Scenario: a cited judgment validates as a finding

- **WHEN** a Stage-2 output asserts net-novelty and cites a resolvable `(projectSnapshotId, shardRef)` or knowledge-statement id
- **THEN** it validates as a net-novel finding
