## MODIFIED Requirements

### Requirement: Local capture includes the complete current local changeset

The system SHALL capture committed branch changes since the resolved base, staged changes, unstaged tracked changes, and non-ignored untracked files into one patchset. App-owned Rennet board storage under `.rennet/boards/` SHALL never enter a working-tree patchset's files, raw diff, or identity — including in a repository with no pre-existing Rennet ignore rule — while intentionally tracked project content under `.rennet` SHALL remain captured.

#### Scenario: Repository contains mixed local change sources

- **WHEN** a branch has committed, staged, unstaged, and non-ignored untracked changes
- **THEN** the captured patchset identifies every changed path and records which base and head object IDs were used

#### Scenario: Repository has no local changes

- **WHEN** capture produces no changed paths and no diff bytes
- **THEN** the system returns an explicit empty-changeset result instead of creating a misleading review

#### Scenario: Board storage exists in a repository without an ignore rule

- **WHEN** capture runs in a repository that does not ignore `.rennet/` and app-owned files exist under `.rennet/boards/`
- **THEN** the captured patchset's files, raw diff, and derived identity contain no `.rennet/boards/` content

#### Scenario: Tracked project content lives under .rennet

- **WHEN** the repository intentionally tracks a file under `.rennet/` outside `boards/` and that file changed
- **THEN** the change is captured like any other tracked change

## ADDED Requirements

### Requirement: App-owned board artifacts never invalidate an unchanged review

Freshness evaluation SHALL agree with capture about app-owned paths. After a round lands to an uncommitted working tree and the daemon restarts, a freshness recapture of an unchanged source tree SHALL keep the successor review current: no stale notice, and no candidate patchset whose only difference is app-owned board state.

#### Scenario: Daemon restarts after a landed round

- **WHEN** a review is current on a working-tree successor patchset, board state has been written under `.rennet/boards/`, and the daemon restarts and rechecks freshness with source files unchanged
- **THEN** the review remains current and no app-artifact-driven candidate becomes pending

#### Scenario: Positive control edits a reviewed source file

- **WHEN** the same restart-and-recheck flow runs after a reviewed source file was actually edited
- **THEN** the freshness check invalidates the review
