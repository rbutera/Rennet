## ADDED Requirements

### Requirement: A dual-model lens runs two independent minds fed the same disconfirmers
For a lens configured as dual-model, the system SHALL resolve two seats — one per installed provider — through the Model Council, run the SAME lens runner once per seat INDEPENDENTLY, and feed both seats the same hypothesis disconfirmers and the same offered manifest. Neither seat's output SHALL be shown to the other, and each seat SHALL ground and validate its own findings through the existing runner path.

#### Scenario: Both providers produce independent finding sets
- **WHEN** a dual-model Flagged lens runs with both Claude and Codex installed
- **THEN** the runner executes once per provider, each fed the same disconfirmers, and returns two independently grounded, validator-admitted finding sets

#### Scenario: The executing harness follows the resolved model
- **WHEN** a seat resolves to a Codex model
- **THEN** that seat's turn runs through the Codex port and its provenance records the Codex harness, never a Codex model stamped as a Claude run

### Requirement: Disagreement is reconciled deterministically and never averaged
A pure reconcile SHALL fold the two seats' findings into one set with a populated agreement state: findings that match by anchor proximity and comparable severity become a single `concur` finding carrying both votes; a finding raised by only one seat, or two conflicting verdicts at one anchor, become a `disagree` finding carrying each model's answer side by side, labelled. The reconcile SHALL NOT produce a third, merged summary, and the resulting shape SHALL have no field able to express one.

#### Scenario: Overlapping findings concur
- **WHEN** both seats raise a finding at the same anchor with comparable severity
- **THEN** the reconcile emits one finding with `concur` and a vote of two of two

#### Scenario: A solo finding becomes a labelled disagreement
- **WHEN** only one seat raises a finding at an anchor
- **THEN** the reconcile emits a `disagree` finding whose answers show the raising model's summary and the other model's absence of concern, each labelled by model

#### Scenario: No synthesis is ever produced
- **WHEN** the two seats conflict at an anchor
- **THEN** both answers are carried side by side and no averaged or merged verdict is generated

### Requirement: Disagreement surfaces as a first-class mark in the lens
The reconciled findings SHALL flow through the existing Flagged lens index unchanged, so a `disagree` finding renders each model's answer side by side and labelled at its anchor, and a review that ran and found nothing stays distinct from a runner that failed. Disagreement SHALL be an index mark the reviewer can jump to, never a chat interruption or a synthesis block.

#### Scenario: A disagreement renders side by side in the index
- **WHEN** the lens renders a reconciled set containing a `disagree` finding
- **THEN** the row shows both models' answers side by side, labelled, at the finding's anchor

### Requirement: Single-provider availability degrades honestly
When only one provider is installed, the lens SHALL run single-model, keep each finding's existing self-concur agreement, and carry a visible "single provider — no second opinion" indication. Dual-model SHALL be a capability that activates when two providers are installed, never a hard requirement that blocks a review.

#### Scenario: One provider yields a badged single-model review
- **WHEN** only Claude (or only Codex) is installed
- **THEN** the lens runs once, findings keep a one-of-one concur agreement, and the lens is marked single-provider

### Requirement: Optional adjudication only adds a note, never a verdict
When adjudication is explicitly enabled, a genuine same-anchor conflict MAY trigger one additional adjudication turn that appends a labelled "which is more likely" note to the disagreement. It SHALL NOT collapse the two answers into one, and the default SHALL be that disagreement is shown, not adjudicated.

#### Scenario: Adjudication is off by default
- **WHEN** a conflict occurs and adjudication is not enabled
- **THEN** the disagreement is shown with both answers and no adjudication turn runs
