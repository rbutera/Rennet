## ADDED Requirements

### Requirement: Non-obvious findings are selected for verification deterministically
A deterministic, versioned classifier SHALL decide which findings pay for a verification turn. A finding is non-obvious — and SHALL be verified — when it is a higher-severity behavioural or correctness claim that requires reasoning beyond its anchored hunk. A finding is obvious — and SHALL be surfaced directly without verification — when it is a low-severity nit or a claim already settled mechanically by the deterministic floor. The classifier SHALL run no model turn.

#### Scenario: A behavioural claim is marked for verification
- **WHEN** a high or medium severity finding asserts a defect that cannot be confirmed from the anchored hunk alone
- **THEN** the classifier marks it non-obvious and it is routed to verification

#### Scenario: A low-severity nit is surfaced without verification
- **WHEN** a low-severity stylistic finding is produced
- **THEN** the classifier marks it obvious and it surfaces directly with no verification chip

### Requirement: Each non-obvious finding is reproduced or refuted against the real code
Each non-obvious finding SHALL be sent to a fresh verification session — a new run, by default a different seat than the one that raised it — fed the real file content around its anchor (more than the offered hunk) and instructed to either reproduce the claim (cite the concrete failure path or the exact lines that make it true) or refute it (show why it does not hold). The verification SHALL produce a verdict of reproduced, refuted, or inconclusive with a one-line evidence string.

#### Scenario: A verifier is not asked to certify its own claim
- **WHEN** a finding is verified
- **THEN** the verification runs in a fresh session with its own provenance, and by default on a seat other than the one that raised the finding

#### Scenario: The verifier reads more than the offered hunk
- **WHEN** the verification session runs
- **THEN** it is fed the real file content around the anchor via the context reader, so it can trace the claim through the actual code rather than the hunk alone

### Requirement: Verification disposition — drop refuted, chip reproduced, caveat inconclusive
A refuted finding SHALL be dropped and never surface. A reproduced finding SHALL surface with its evidence attached. An inconclusive finding SHALL surface with an honest "could not verify" caveat and SHALL NOT be silently dropped, so a dead or uncertain verifier never reads as an all-clear.

#### Scenario: A refuted finding never reaches the index
- **WHEN** verification refutes a finding
- **THEN** the finding is dropped and does not appear in the lens

#### Scenario: A reproduced finding carries its evidence chip
- **WHEN** verification reproduces a finding
- **THEN** the finding surfaces with its verification verdict and evidence, and the lens renders the evidence chip at its anchor

#### Scenario: An inconclusive finding surfaces caveated, not dropped
- **WHEN** verification cannot reproduce or refute a finding
- **THEN** the finding surfaces with a "could not verify" caveat rather than being removed

### Requirement: The evidence chip is an additive optional field on a finding
The `finding` element SHALL gain an optional verification field carrying the verdict and evidence, and this SHALL be an additive superset: a finding without verification validates and renders exactly as before, and existing `finding` documents remain admissible unchanged.

#### Scenario: An unverified finding is unchanged
- **WHEN** a finding has no verification field
- **THEN** it validates and renders exactly as it does today

#### Scenario: A verified finding validates with the new field
- **WHEN** a finding carries a verification verdict and evidence
- **THEN** the document is admitted and the field is preserved

### Requirement: Verification is bounded by the shared budget and a per-review cap
Verification turns SHALL draw from the one shared invocation budget and SHALL be bounded by a per-review cap and by batching findings that share a file or region into a single turn. When the cap or budget is reached, the remaining non-obvious findings SHALL surface with a "not verified" caveat rather than blocking the review or spending unbounded turns.

#### Scenario: Findings beyond the cap surface unverified
- **WHEN** the number of non-obvious findings exceeds the per-review verification cap
- **THEN** the top findings by severity are verified and the remainder surface with a "not verified" caveat

#### Scenario: An exhausted budget stops verification spend, not the review
- **WHEN** the shared budget refuses a verification turn
- **THEN** the affected finding surfaces with a "not verified" caveat and the review still completes
