# knowledge-disposition

## ADDED Requirements

### Requirement: Statement disposition persists
The system SHALL expose a `project.knowledgeDisposition` command that sets a knowledge statement's status to `confirmed` or `rejected` by id and persists the updated set via the local knowledge store, preserving every statement's id (the claim content is never edited by disposition) and the set's deterministic id ordering.

#### Scenario: Confirming a hypothesis
- **WHEN** `project.knowledgeDisposition` is invoked with a statement id and disposition `confirmed`
- **THEN** the stored set's statement carries status `confirmed`, its id and claim are unchanged, and a subsequent `project.contextMap` read returns the confirmed status

#### Scenario: Rejecting a statement
- **WHEN** `project.knowledgeDisposition` is invoked with a statement id and disposition `rejected`
- **THEN** the stored statement carries status `rejected`, remains in the set as an honest record, and is excluded from hypothesis/confirmed presentation and from ask context

#### Scenario: Unknown statement id
- **WHEN** the id does not exist in the project's local knowledge set
- **THEN** the command returns a typed not-found result and the stored set is unchanged

### Requirement: Rejected status in the knowledge vocabulary
The `KnowledgeStatus` type SHALL include `"rejected"` alongside `"hypothesis"` and `"confirmed"`, so a human rejection is a recorded state rather than a deletion, and re-enrichment passes MUST NOT resurrect a rejected statement as a fresh hypothesis with the same id.

#### Scenario: Delta pass preserves rejection
- **WHEN** a knowledge delta pass runs over a set containing a rejected statement whose subject region is unchanged
- **THEN** the rejected statement's status survives the pass unchanged

### Requirement: Disposition verbs on the surface
The Context Map surface SHALL offer confirm and reject actions on each hypothesis statement and a discuss action that feeds the statement into the conversation rail; disposition actions MUST reflect the persisted result, not an optimistic guess.

#### Scenario: Confirm from the surface
- **WHEN** the user confirms a hypothesis in the knowledge panel
- **THEN** the surface invokes `project.knowledgeDisposition` and re-renders the statement with its persisted `confirmed` status
