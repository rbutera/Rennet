## ADDED Requirements

### Requirement: Review history is append-only
The system SHALL store review changes as ordered versioned events and SHALL derive current review state by folding those events in sequence.

#### Scenario: Review is reopened after application restart
- **WHEN** the app starts with a previously created local review
- **THEN** the same patchset, file summaries, and read states are reconstructed from persisted events

#### Scenario: Unknown future event is encountered
- **WHEN** replay encounters an event type or version the running build cannot interpret
- **THEN** loading fails closed and the review is not shown as current or publishable

### Requirement: Mutating commands are idempotent
The system SHALL record a command receipt and its payload digest in the same transaction as emitted events, SHALL return the recorded result for a byte-identical replay, and SHALL reject reuse of a command ID with different payload bytes.

#### Scenario: Identical capture command is retried
- **WHEN** the same command ID and payload are submitted after a completed capture
- **THEN** the recorded result is returned without appending another event

#### Scenario: Command ID is reused with different input
- **WHEN** a known command ID is submitted with a different payload digest
- **THEN** the command fails and no event is appended

### Requirement: Read state is patchset-scoped
The system SHALL associate file read state with the active immutable patchset and SHALL not silently carry read state to a different patchset.

#### Scenario: User marks a file read
- **WHEN** a file is marked read on the active patchset
- **THEN** reopening the review shows that file as read for that patchset

#### Scenario: Review regenerates after source changes
- **WHEN** regeneration accepts a different patchset
- **THEN** changed-file read state starts unread while the previous patchset's state remains in history

### Requirement: Storage remains local and purgeable
The system SHALL create its SQLite database only under Rennet-owned application storage and SHALL expose no network transport or telemetry from persistence.

#### Scenario: Store is initialized
- **WHEN** the desktop host first opens the review store
- **THEN** the database is created below the provided Rennet application-data directory and nowhere inside the reviewed repository
