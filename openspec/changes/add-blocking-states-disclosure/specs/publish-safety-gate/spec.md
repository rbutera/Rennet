## ADDED Requirements

### Requirement: The publish sheet discloses blocked ingestion before signing

The publish sheet SHALL display the review's incomplete-ingestion blocking states (R18: truncated, binary, submodule) before the sign control whenever the set is non-empty, each entry naming its reason and its human-facing detail — so a signer knows the review ran over partially-ingested content before attesting to it. The disclosure SHALL be non-gating honest copy: it SHALL NOT block, delay, or add any acknowledgement step to the sign path — the user finishes and publishes anyway if they choose (R18), and the existing sign mechanics (hold budget, keyboard sign, degradation-ledger gate) are unchanged by its presence or absence.

#### Scenario: Blocked ingestion is visible on the sheet before signing

- **WHEN** the publish sheet renders for a review whose blocking states carry a binary entry
- **THEN** the sheet displays the blocked-ingestion disclosure with the entry's reason and detail before the sign control

#### Scenario: The disclosure never gates the sign

- **WHEN** the sheet carries a non-empty blocked-ingestion disclosure and the user completes a sufficient hold on the sign control
- **THEN** the sign completes exactly as it would without the disclosure — no additional acknowledgement, confirmation, or consent step is required

#### Scenario: Full ingestion shows no disclosure

- **WHEN** the publish sheet renders for a review whose blocking states are empty or absent
- **THEN** no blocked-ingestion disclosure renders and the sheet is byte-identical to its pre-change form
