# cross-harness-adjudication Specification

## Purpose
Defines independent cross-harness finding adjudication and the synthetic calibration corpus used to measure it.
## Requirements
### Requirement: Divergence, and only divergence, triggers an adjudication turn

The adjudication pass SHALL run one model turn for each reconciled finding whose agreement is `disagree`, including solo findings and severity conflicts. The Model Council SHALL resolve the seat for the `adjudication` job. Rows whose agreement is `concur` SHALL consume no adjudication turn. Each prompt SHALL identify which seat flagged the claim at which anchor and what the other seat reported. For a solo finding, the other answer SHALL read "no concern raised here." The prompt SHALL include file content around the anchor, not only the offered hunk. Adjudication SHALL draw from the review's shared invocation budget and obey the per-review cap.

#### Scenario: A disagree row is adjudicated on the council's adjudication seat

- **WHEN** a dual review reconciles a solo finding (one seat flagged, the other did not) and the adjudication pass runs
- **THEN** exactly one adjudication turn runs for that row, on the seat resolved for the council's `adjudication` job, and its prompt carries both seats' labelled answers with the flagging seat's claim stated at its anchor plus surrounding real file content

#### Scenario: Agreement spends nothing

- **WHEN** every reconciled row is `concur`
- **THEN** the adjudication pass runs zero model turns

### Requirement: The verdict is a three-way judgement that informs and never gates

Each adjudicated row SHALL carry one verdict: `supported` when the code supports the claim, `contradicted` when the code refutes it, or `insufficient` when neither can be established. It SHALL also carry one evidence line and the adjudicating seat's identity. The verdict SHALL remain optional on a disagree row, and a row without one SHALL still validate and render. Adjudication SHALL never drop, hide, or block a finding, and initial rendering SHALL not wait for adjudication or calibration. A turn failure, reached cap, or exhausted budget SHALL produce `insufficient` with the reason.

#### Scenario: A contradicted flare still renders, now informed

- **WHEN** the adjudicator returns `contradicted` for a solo finding
- **THEN** the row remains a disagreement with both seats' verbatim answers and carries the `contradicted` verdict, its evidence line, and the adjudicating seat

#### Scenario: An exhausted budget is an honest insufficient

- **WHEN** the shared budget or the per-review cap prevents adjudicating a contested row
- **THEN** that row surfaces unadjudicated or as `insufficient` with the bound named as its reason, and is never dropped

#### Scenario: Initial row delivery never waits on adjudication

- **WHEN** verified disagree rows are ready and one or more adjudication turns remain pending or hang
- **THEN** the initial flagged-review command returns those rows immediately, and a keyed follow-up read adds the verdicts only after they finish

### Requirement: The seeded ground-truth corpus is synthetic and Rennet-owned

The calibration corpus SHALL contain only Rennet-authored synthetic diffs with planted bugs and clean controls. Each committed item SHALL declare its claim class and known verdict. No item SHALL derive from client repositories, code, pull requests, or data. Each item SHALL use the offered-manifest format consumed by live finding and adjudication code.

#### Scenario: A corpus item carries its ground truth

- **WHEN** a corpus item is read
- **THEN** it names its claim class, its known verdict (planted bug present, or clean), and the synthetic diff content the seats review

### Requirement: Calibration is measured by gated real runs and committed as a table, never hand-edited

Scoring SHALL be a pure function. For each corpus item, it SHALL compare reconciled agreement and explicit adjudication against the known verdict, then aggregate results by claim class. The default gate SHALL use fake in-process seats, spawn no harness process, and spend no tokens. An opt-in real run SHALL drive both installed harnesses over the corpus, adjudicate disagreements, and write the per-class calibration table. Only a completed real run SHALL write that table. No product code SHALL use calibration data to block rendering, posting, or seat selection.

#### Scenario: The default gate spends nothing

- **WHEN** the repository gate runs the adjudication and calibration tests
- **THEN** no harness binary is spawned and no calibration artifact is written

#### Scenario: A real run writes the committed table

- **WHEN** the opt-in real calibration run completes over the corpus with both harnesses installed
- **THEN** the committed artifact records, per claim class, raw overlap's accuracy and explicit adjudication's accuracy against the known verdicts, and no other source can write it

#### Scenario: A partial or ambiguous run records nothing

- **WHEN** any corpus review fails, an outcome is missing, duplicated, unknown, joined to the wrong seeded claim, or matches multiple findings
- **THEN** scoring fails before the committed table is atomically replaced

### Requirement: Contested generation is fresh-session independent

The two seats whose disagreement feeds adjudication SHALL have generated their findings in independent fresh sessions: no seat's generation session SHALL be a fork, resume, or continuation of the other's, and neither seat SHALL see the other's output before reconciliation. The adjudication turn itself SHALL run in its own fresh session, not a continuation of either generating seat. This independence SHALL be asserted by test.

#### Scenario: No forked-session generation path exists

- **WHEN** the dual review runs both seats and the adjudication pass follows
- **THEN** each seat's turns and the adjudicator's turn are separate sessions with no shared conversational state, and a test fails if any seat is fed the other's findings before reconciliation
