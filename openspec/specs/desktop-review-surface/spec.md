# desktop-review-surface Specification

## Purpose
TBD - created by archiving change build-local-review-mvp. Update Purpose after archive.
## Requirements
### Requirement: Renderer authority is restricted
The system SHALL run the renderer with context isolation and sandboxing enabled, Node integration disabled, a strict content security policy, exact-origin sender validation, and a preload API containing only the typed command invocation surface.

#### Scenario: Renderer invokes an allowed command
- **WHEN** the renderer sends a known command with schema-valid input from the allowed origin
- **THEN** the main process validates the input, executes the command, validates the output, and returns it

#### Scenario: Renderer sends unknown or invalid input
- **WHEN** the renderer sends an unknown command or schema-invalid payload
- **THEN** the dispatcher rejects it before domain or adapter code runs

### Requirement: User can start and resume a local review
The system SHALL let the user choose a repository, capture a review, and resume the latest persisted review after restart.

#### Scenario: First launch has no review
- **WHEN** no persisted review exists
- **THEN** the surface explains the local-only workflow and offers one clear repository-selection action

#### Scenario: Existing review is available
- **WHEN** the application starts with a valid persisted review
- **THEN** the latest review opens with repository, patchset, provenance, file list, raw diff, and read progress visible

### Requirement: Review coverage state is honest
The system SHALL show every captured changed file, per-file read state, total read progress, raw diff content, and any truncation or unsupported capture state. It SHALL not label absent semantic/model analysis as complete.

#### Scenario: User reads changed files
- **WHEN** the user selects files and marks them read
- **THEN** the progress indicator updates from persisted patchset-scoped state

#### Scenario: Capture is incomplete
- **WHEN** the patchset is truncated or includes an unsupported state
- **THEN** the surface shows a blocking incomplete-capture notice rather than a completed review state

### Requirement: Source changes invalidate without destroying prior output
The system SHALL retain the displayed patchset when repository recapture differs, mark the review invalid, and offer explicit regeneration. It SHALL not regenerate model-backed or semantic output automatically.

#### Scenario: Repository changes while review is open
- **WHEN** a watched source change produces a different patchset identity
- **THEN** the current review remains visible with an invalid banner and a regenerate action

#### Scenario: User explicitly regenerates
- **WHEN** the user activates regenerate after invalidation
- **THEN** a new immutable patchset becomes active and the prior patchset remains persisted in history

