## ADDED Requirements

### Requirement: A hypothesis is committed before the lens runners read the diff
The system SHALL run a hypothesis pre-read pass that produces a committed `review.hypothesis` document — Domain, Scope (in/out), the design it would have chosen, and 5–10 concrete Risks — from the change's stated intent, its structure, and the repo context, BEFORE any lens runner reads the hunks. The pass SHALL mirror the existing runner shape: an offered manifest for identity, a versioned prompt contract, an injected turn, a shared invocation budget, and a validator-admitted RSP envelope whose `docId` and `inputDigest` are stamped by the pass and never by the agent.

#### Scenario: The hypothesis is produced from intent and repo context
- **WHEN** the pass runs over a change with a PR title/body (or committed spec) and available repo context
- **THEN** it emits an admitted `review.hypothesis` document carrying a domain, an in/out scope, a design expectation, and between five and ten risks, each with a severity and a disconfirmer

#### Scenario: The pass forms a prior, not a diff summary
- **WHEN** the pass is invoked
- **THEN** it is fed the intent, the changed-file list, and the decomposition chunk titles plus repo context, and it is NOT fed the full hunk line text, so its risks are expectations to check rather than a restatement of the code

### Requirement: The pass degrades honestly when intent or repo context is absent
The pass SHALL run on whatever inputs are present and SHALL never fabricate an input. With no intent it reasons over structure and repo context alone; with the repo-context backend refusing (absent, stale, corrupt, or over the size ceiling) it reasons over intent and structure alone and records that the repo context was absent. A pass that cannot complete SHALL resolve to an honest `failed` state, distinct from a pass that ran and produced a hypothesis.

#### Scenario: Missing repo context does not block the hypothesis
- **WHEN** the ProjectSnapshot backend returns a typed refusal for the review's base
- **THEN** the pass still produces a hypothesis from intent and structure and marks the repo context as absent, and no snapshot is fabricated

#### Scenario: A failed pass is not conflated with an empty one
- **WHEN** every attempt of the pass fails or the budget refuses it
- **THEN** the result carries `failed` with a reason, and downstream stages treat that as "no hypothesis," never as an empty-but-successful hypothesis

### Requirement: The hypothesis feeds every lens runner as disconfirmation criteria
When a hypothesis is present, each lens runner SHALL receive it and render its domain, scope, design expectation, and numbered risks-with-disconfirmers as a labelled layer in the assembled prompt, positioned after the base instruction and before the payload, and SHALL be instructed to surface a finding where the change diverges from an expectation. The hypothesis is the vehicle by which intent reaches runners that do not themselves take an intent input.

#### Scenario: A runner receives the hypothesis as a labelled disconfirmation layer
- **WHEN** a lens runner assembles its prompt with a hypothesis supplied
- **THEN** the assembled prompt contains a labelled hypothesis layer carrying the risks and their disconfirmers, and the base instruction is never truncated to fit it

#### Scenario: Absent hypothesis leaves runner behaviour unchanged
- **WHEN** a lens runner is invoked with no hypothesis
- **THEN** it assembles and runs exactly as it does today, with no hypothesis layer

### Requirement: The predicted-risk cross-check reconciles risks against findings
After the lens runners return, a deterministic cross-check SHALL match each hypothesised risk against the produced findings and mark it confirmed (a finding addresses it) or open (no finding addresses it). An open risk SHALL be surfaced to the human as a risk to check themselves, never silently discarded. The cross-check SHALL run no model turn.

#### Scenario: A predicted-and-found risk is confirmed
- **WHEN** a finding's anchor and substance match a hypothesised risk's disconfirmer
- **THEN** that risk is marked confirmed and the finding is associated with the risk

#### Scenario: A predicted-but-unflagged risk is surfaced as open
- **WHEN** no finding addresses a hypothesised risk
- **THEN** that risk is marked open and presented as a manual check for the human, and it is not dropped

### Requirement: The hypothesis is the human's reading frame
The system SHALL deliver the hypothesis and its cross-check as a first-class reading frame rendered from a host-free derivation, showing the domain, the in/out scope, the design expectation, and the risk list with each risk's confirmed/open status and a jump to any associated finding. The frame SHALL be delivered alongside the canvas set and SHALL NOT be embedded on a `Canvas`, so canvas projection stays byte-identical for replay.

#### Scenario: The frame renders the committed hypothesis and risk statuses
- **WHEN** a review with a produced hypothesis is opened
- **THEN** the reading frame shows the domain, scope, design expectation, and each risk with its confirmed or open status and any linked finding anchors
