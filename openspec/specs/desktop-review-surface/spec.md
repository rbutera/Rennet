# desktop-review-surface Specification

## Purpose
Defines the desktop review workspace, persisted review recovery, honest capture state, invalidation, and durable navigation.
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
The system SHALL let the user choose a repository, capture a review, and resume the latest persisted review after restart. It SHALL also reopen a persisted review by id without its original worktree or PR context. Files, patches, read states, dispositions, the delta account, and conversation threads SHALL render from persisted data. If the repository root no longer exists, the workspace SHALL state that plainly and skip its freshness watcher. Actions that need the repository SHALL report that they are unavailable. Reopening SHALL require no confirmation and SHALL not block on missing context.

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
- **THEN** a new immutable patchset becomes active and the prior patchset remains available for comparison

### Requirement: Navigation history survives an app restart
The system SHALL persist the back and forward navigation stacks as local UI state and restore them on launch. It SHALL load a review or project when the user lands on that entry. If an entry cannot load, the system SHALL discard it from the active and forward routes, show a plain status, and land on the nearest restorable ancestor. The Projects root SHALL always restore. Each stack half SHALL contain at most 100 entries. A valid route SHALL start at the root, and all review descendants SHALL use the same review id. Unreadable or invalid state SHALL fall back to recents without a migration prompt. A restored route SHALL never render another route's content under its breadcrumb.

#### Scenario: Restart restores the stack tip
- **WHEN** the app restarts after the user left off inside a review reached from a project
- **THEN** the app reopens on that review with the same breadcrumb trail, and back navigates to the project detail, rehydrating it if its content is not yet loaded

#### Scenario: A restored entry no longer loads
- **WHEN** the restored stack's tip references a review or project that can no longer be loaded
- **THEN** that entry is dropped with a plain status naming what could not be reopened, and the app lands on the nearest restorable ancestor

#### Scenario: Invalid persisted navigation state
- **WHEN** the persisted navigation blob is unreadable or contains no stack
- **THEN** the app starts with default navigation, preserves readable recents, and shows no migration prompt or error ceremony
