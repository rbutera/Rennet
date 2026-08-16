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
The system SHALL let the user choose a repository, capture a review, and resume the latest persisted review after restart. It SHALL also reopen any persisted review by id without its original worktree or PR context: the persisted review (files, patches, read states, dispositions, delta account, conversation threads) renders as persisted, and when the original repository root no longer exists the surface SHALL show a plain status stating that, skip the working-tree freshness watcher for that review, and let repo-dependent live surfaces report their existing honest unavailable states. Reopening SHALL never require confirmation and SHALL never block on missing context.

#### Scenario: First launch has no review
- **WHEN** no persisted review exists
- **THEN** the surface explains the local-only workflow and offers one clear repository-selection action

#### Scenario: Existing review is available
- **WHEN** the application starts with a valid persisted review
- **THEN** the latest review opens with repository, patchset, provenance, file list, raw diff, and read progress visible

#### Scenario: A persisted review is reopened without its worktree
- **WHEN** a persisted review is reopened by id and its repository root no longer exists on disk
- **THEN** the review surface shows the persisted patchset, files, and dispositions with a plain status that the original worktree is gone, no freshness poll runs against the missing root, and no confirmation is asked

#### Scenario: A persisted review is reopened with its repository present
- **WHEN** a persisted review is reopened by id and its repository root exists
- **THEN** the review opens as persisted and the existing freshness machinery decides staleness after the open, exactly as it does for a resumed review

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

### Requirement: Navigation history survives an app restart
The system SHALL persist the navigation surface stack and forward stack as plain local UI state and restore them on the next launch, so the app reopens where the user left off. Restoring SHALL rehydrate each surface's content when the user lands on it (loading a review by id, or a project's detail); an entry whose content can no longer load SHALL be discarded from both the active and forward route with a plain status, flooring to the nearest ancestor that restores — the Projects root always restores. Persisted navigation SHALL be bounded to 100 entries per stack half and SHALL accept only a rooted legal route whose review-family descendants all carry the same review id. Unreadable, older, or semantically invalid state SHALL degrade to the pre-existing recents-only behavior without any migration step or prompt, and a restored surface SHALL never render another surface's content under its crumb.

#### Scenario: Restart restores the stack tip
- **WHEN** the app restarts after the user left off inside a review reached from a project
- **THEN** the app reopens on that review with the same breadcrumb trail, and back navigates to the project detail, rehydrating it if its content is not yet loaded

#### Scenario: A restored entry no longer loads
- **WHEN** the restored stack's tip references a review or project that can no longer be loaded
- **THEN** that entry is dropped with a plain status naming what could not be reopened, and the app lands on the nearest restorable ancestor

#### Scenario: Older or corrupt persisted navigation state
- **WHEN** the persisted navigation blob is unreadable or predates stack persistence
- **THEN** the app starts with its existing default navigation (recents preserved where readable) and no migration prompt or error ceremony

