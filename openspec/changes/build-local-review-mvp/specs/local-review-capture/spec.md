## ADDED Requirements

### Requirement: Repository validation is read-only
The system SHALL accept only a directory that Git identifies as a worktree, SHALL resolve its canonical repository root and git-common-dir, and SHALL perform no command that mutates the source working tree, index, refs, config, hooks, or worktree metadata.

#### Scenario: User selects a valid repository
- **WHEN** the user selects a directory inside a Git worktree
- **THEN** the system resolves and displays the canonical repository root without changing repository state

#### Scenario: User selects a non-repository
- **WHEN** the selected directory is not inside a Git worktree
- **THEN** capture fails with a structured validation error and no review is created

### Requirement: Local capture includes the complete current local changeset
The system SHALL capture committed branch changes since the resolved base, staged changes, unstaged tracked changes, and non-ignored untracked files into one patchset.

#### Scenario: Repository contains mixed local change sources
- **WHEN** a branch has committed, staged, unstaged, and non-ignored untracked changes
- **THEN** the captured patchset identifies every changed path and records which base and head object IDs were used

#### Scenario: Repository has no local changes
- **WHEN** capture produces no changed paths and no diff bytes
- **THEN** the system returns an explicit empty-changeset result instead of creating a misleading review

### Requirement: Patchsets are immutable and content-addressed
The system SHALL derive patchset identity from canonical repository provenance and captured bytes, SHALL never overwrite an existing patchset, and SHALL retain the previous patchset when later source state differs.

#### Scenario: Same source state is captured twice
- **WHEN** identical repository provenance and bytes are captured twice
- **THEN** both captures resolve to the same patchset identity

#### Scenario: Source changes after capture
- **WHEN** any captured provenance or byte changes after a review begins
- **THEN** a different patchset identity is produced and the original patchset remains available

### Requirement: Incomplete capture is visible
The system SHALL bound captured bytes, identify truncation or unsupported binary states, and SHALL not represent incomplete ingestion as complete.

#### Scenario: Patch exceeds the capture budget
- **WHEN** the raw patch exceeds the configured byte limit
- **THEN** the patchset records truncation and the review surface shows that completion-grade coverage is unavailable
