# Local review capture specification

## Purpose
Define read-only repository validation and complete, immutable capture of a local Git changeset into a review patchset.
## Requirements
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

### Requirement: Hunk-body content is never interpreted as file metadata

On the REST fallback path, the system SHALL interpret file metadata only in the preamble before the first `@@` hunk header. Metadata includes `--- ` and `+++ ` path headers, mode changes, and renames. After the first hunk header, the parser SHALL classify each line only by its prefix. A line beginning `+` is an addition, and a line beginning `-` is a deletion. Hunk content SHALL NOT change a file's key, paths, or status.

#### Scenario: An added body line rendering as a +++ header does not re-key the file

- **WHEN** a REST-fallback diff block for `actual.txt` contains, inside a hunk, an added source line whose content is `++ b/pnpm-lock.yaml` (rendered in the diff as `+++ b/pnpm-lock.yaml`)
- **THEN** the parsed file is keyed `actual.txt`, no `pnpm-lock.yaml` file appears in the result, and the adversarial line is counted in `additions`

#### Scenario: A deleted body line rendering as a --- header is counted as a deletion

- **WHEN** a hunk contains a deleted source line whose content is `-- b/some/path` (rendered `--- b/some/path`)
- **THEN** the line is counted in `deletions` and has no effect on the file's previous path

#### Scenario: The same-family core parser keeps body lines as body

- **WHEN** a per-file patch handed to decomposition contains, inside a hunk, an added line rendered `+++ b/other.txt`
- **THEN** the hunk's body carries that line as an addition with content `++ b/other.txt`, and no metadata interpretation occurs
