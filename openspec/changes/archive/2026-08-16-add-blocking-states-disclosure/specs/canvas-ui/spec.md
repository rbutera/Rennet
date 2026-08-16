## ADDED Requirements

### Requirement: The Flagged empty state discloses blocked ingestion

The Flagged lens SHALL receive the review's incomplete-ingestion blocking states (R18: truncated, binary, submodule) alongside the flagged result, and SHALL render a disclosure of them whenever the set is non-empty — each entry naming its reason and its human-facing detail. When blocking states are non-empty, the unqualified all-clear copy ("ran clean") SHALL be unreachable: a review that flagged nothing over partially-ingested content SHALL state that nothing was flagged in what could be read AND that some content was not ingested. The disclosure is honest copy only — it SHALL NOT add any confirmation, acknowledgement, or gate to the lens.

#### Scenario: An empty result over blocked ingestion is qualified, never "ran clean"

- **WHEN** the Flagged lens renders a review that flagged nothing and whose blocking states carry a truncated or binary entry
- **THEN** the lens does not display the unqualified "ran clean" all-clear, and instead displays the qualified empty state plus the blocked-ingestion disclosure with each entry's reason and detail

#### Scenario: A fully-ingested empty result keeps the honest all-clear

- **WHEN** the Flagged lens renders a review that flagged nothing and whose blocking states are empty
- **THEN** the existing honest all-clear renders unchanged ("ran clean, not skipped"), with no disclosure block

#### Scenario: Blocked ingestion is disclosed even beside findings

- **WHEN** the Flagged lens renders a review with one or more findings and non-empty blocking states
- **THEN** the blocked-ingestion disclosure renders beside the findings, because an absence of findings over un-ingested content is not evidence it was reviewed

#### Scenario: Blocked ingestion is disclosed when automated review fails

- **WHEN** the Flagged lens renders a failed automated review with non-empty deterministic blocking states
- **THEN** the existing "Couldn't check" state remains visible and the blocked-ingestion disclosure renders beside it
- **AND WHEN** the failed review has no blocking states
- **THEN** the failed state renders exactly as it did before the disclosure change
