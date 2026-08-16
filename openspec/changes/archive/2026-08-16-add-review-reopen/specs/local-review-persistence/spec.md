# local-review-persistence — delta for add-review-reopen

## ADDED Requirements

### Requirement: Any persisted review is loadable by id
The system SHALL load any persisted review by its id as a pure read: the load SHALL return the review exactly as folded from its persisted events (patchsets, active patchset, dispositions, provenance, delta account), SHALL append no event, and SHALL NOT depend on the review being the most recently created one. Commands that address a review by id SHALL resolve it from the store by that id rather than asserting it equals the globally-latest review.

#### Scenario: An older review is loaded while a newer one exists
- **WHEN** a load is requested for a review id that is persisted but is not the most recent review in the store
- **THEN** that review is returned as persisted, and subsequent id-addressed commands (threads reattach, disposition reads, canvas requests) operate on it rather than failing with a not-found error

#### Scenario: Loading appends nothing
- **WHEN** a persisted review is loaded by id
- **THEN** the store's event history for that review is byte-identical before and after the load, and a subsequent load returns the same review

#### Scenario: Unknown id fails plainly
- **WHEN** a load is requested for an id no persisted review has
- **THEN** the load fails with a plain not-found error and no review state changes

### Requirement: Loading discloses whether the original repository is still present
The system SHALL report, with each load and with latest-review bootstrap, whether the review's recorded repository root currently exists on disk, so callers can render honest status instead of guessing. The report SHALL NOT block or alter the loaded review, and a missing root SHALL NOT be admitted or watched.

#### Scenario: The original worktree is gone
- **WHEN** a persisted review is loaded and its repository root no longer exists
- **THEN** the load still returns the full persisted review, marked as having no present repository

#### Scenario: The repository is still present
- **WHEN** a persisted review is loaded and its repository root exists
- **THEN** the load returns the review marked as having a present repository, and the existing freshness machinery may subsequently mark it stale — after the load, never blocking it

### Requirement: Repository work is bound to the addressed review
The system SHALL resolve a review id before repository-dependent work, require the caller path to equal that review's stored repository root, and require that root to be admitted. Own-branch submission SHALL use the same stored-root admission rule as the review handoff write path.

#### Scenario: An allowed path belongs to another review
- **WHEN** freshness or canvases names review A but supplies a separately allowed path B
- **THEN** the command refuses before capturing, appending, or running the canvas pipeline

#### Scenario: Submission names an unadmitted review root
- **WHEN** own-branch submission names a persisted review whose stored root is not admitted
- **THEN** submission refuses plainly without pushing or opening a pull request
