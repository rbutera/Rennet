# cross-harness-adjudication Delta Specification

## Purpose

When the two harness seats disagree about a finding, an explicit adjudication turn asks the code who is right and stamps an informational verdict on the flare; a committed synthetic ground-truth corpus measures, via gated real runs, whether that explicit adjudication actually beats raw overlap.

## ADDED Requirements

### Requirement: Divergence, and only divergence, triggers an adjudication turn

The adjudication pass SHALL run one model turn per contested row — a reconciled finding whose agreement is `disagree` (a solo, or a severity conflict) — on the seat the Model Council resolves for the `adjudication` job. Rows whose agreement is `concur` SHALL NOT consume an adjudication turn. Each turn's prompt SHALL state the contested claim with explicit polarity (which seat flagged what at the anchor, and the other seat's answer — including "no concern raised here" for a solo), and SHALL include real file content around the finding's anchor, not only the offered hunk. The pass SHALL draw from the review's one shared invocation budget and SHALL be bounded by a per-review adjudication cap.

#### Scenario: A disagree row is adjudicated on the council's adjudication seat

- **WHEN** a dual review reconciles a solo finding (one seat flagged, the other did not) and the adjudication pass runs
- **THEN** exactly one adjudication turn runs for that row, on the seat resolved for the council's `adjudication` job, and its prompt carries both seats' labelled answers with the flagging seat's claim stated at its anchor plus surrounding real file content

#### Scenario: Agreement spends nothing

- **WHEN** every reconciled row is `concur`
- **THEN** the adjudication pass runs zero model turns

### Requirement: The verdict is a three-way judgement that informs and never gates

Each adjudicated row SHALL carry a verdict of exactly `supported` (the code evidences the flagged claim), `contradicted` (the code refutes it), or `insufficient` (neither could be established), plus a one-line evidence string and the adjudicating seat's identity. The verdict SHALL be additive-optional on the disagree agreement: a row without it validates and renders exactly as before. A contested row SHALL render regardless of its verdict — adjudication never drops, hides, or blocks a flare, and no rendering path waits on adjudication or calibration. A turn failure, the per-review cap, or an exhausted budget SHALL surface as `insufficient` with its honest reason, never as a silent omission and never as a fabricated verdict.

#### Scenario: A contradicted flare still renders, now informed

- **WHEN** the adjudicator returns `contradicted` for a solo finding
- **THEN** the row still surfaces as a disagreement with both seats' verbatim answers, additionally carrying the `contradicted` verdict, its evidence line, and the adjudicating seat

#### Scenario: An exhausted budget is an honest insufficient

- **WHEN** the shared budget or the per-review cap prevents adjudicating a contested row
- **THEN** that row surfaces unadjudicated or as `insufficient` with the bound named as its reason, and is never dropped

### Requirement: The seeded ground-truth corpus is synthetic and Rennet-owned

The calibration corpus SHALL consist entirely of Rennet-authored synthetic diffs — planted bugs and clean-control items — each committed with a known per-claim verdict and a claim class. No item SHALL derive from client repositories, client code, client pull requests, or any client data. Each corpus item SHALL be expressible as an offered manifest so the same finding and adjudication machinery that serves live reviews runs over it unmodified.

#### Scenario: A corpus item carries its ground truth

- **WHEN** a corpus item is read
- **THEN** it names its claim class, its known verdict (planted bug present, or clean), and the synthetic diff content the seats review

### Requirement: Calibration is measured by gated real runs and committed as a table, never hand-edited

Scoring SHALL be a pure function comparing, per corpus item, raw overlap's answer (the reconciled agreement arithmetic) and explicit adjudication's answer against the known verdict, aggregated per claim class. The default gate SHALL exercise the pass and scorer only against fake in-process seats — zero process spawns, zero token spend. A gated opt-in real run SHALL drive both installed harnesses' finding seats over the corpus, adjudicate the disagreements, and record the per-class calibration table into a committed artifact. The committed table SHALL originate only from real runs — no hand-written calibration values — and SHALL be an informational quality signal: no code path SHALL consume it to gate rendering, publishing, or seat selection.

#### Scenario: The default gate spends nothing

- **WHEN** the repository gate runs the adjudication and calibration tests
- **THEN** no harness binary is spawned and no calibration artifact is written

#### Scenario: A real run writes the committed table

- **WHEN** the opt-in real calibration run completes over the corpus with both harnesses installed
- **THEN** the committed artifact records, per claim class, raw overlap's accuracy and explicit adjudication's accuracy against the known verdicts, and no other source can write it

### Requirement: Contested generation is fresh-session independent

The two seats whose disagreement feeds adjudication SHALL have generated their findings in independent fresh sessions: no seat's generation session SHALL be a fork, resume, or continuation of the other's, and neither seat SHALL see the other's output before reconciliation. The adjudication turn itself SHALL run in its own fresh session, not a continuation of either generating seat. This independence SHALL be asserted by test.

#### Scenario: No forked-session generation path exists

- **WHEN** the dual review runs both seats and the adjudication pass follows
- **THEN** each seat's turns and the adjudicator's turn are separate sessions with no shared conversational state, and a test fails if any seat is fed the other's findings before reconciliation
