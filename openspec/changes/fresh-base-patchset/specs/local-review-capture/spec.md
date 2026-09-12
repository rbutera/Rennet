## MODIFIED Requirements

### Requirement: Local capture includes the complete current local changeset

The system SHALL capture committed branch changes since the resolved base, staged changes, unstaged tracked changes, and non-ignored untracked files into one patchset. The resolved base SHALL be the primary base of the reviewed head as the primary-base-resolution capability defines it: the merge-base of the reviewed head with the newest ref in the clone that names the primary branch, so that a review of a branch cut from a fresher primary than one spelling of it knows carries only that branch's own work. A branch-range capture of a local branch SHALL resolve its base the same way from the project's primary branch name, and the New Chat row's ahead, behind, diffstat and first-commit measurements for that branch SHALL be taken against the same ref. App-owned Rennet board storage under `.rennet/boards/` SHALL never enter a working-tree patchset's files, raw diff, or identity — including in a repository with no pre-existing Rennet ignore rule — while intentionally tracked project content under `.rennet` SHALL remain captured.

#### Scenario: Repository contains mixed local change sources

- **WHEN** a branch has committed, staged, unstaged, and non-ignored untracked changes
- **THEN** the captured patchset identifies every changed path and records which base and head object IDs were used

#### Scenario: Repository has no local changes

- **WHEN** capture produces no changed paths and no diff bytes
- **THEN** the system returns an explicit empty-changeset result instead of creating a misleading review

#### Scenario: Working-tree capture on a branch cut past a stale local primary

- **WHEN** local `main` is behind `origin/main`, the checked-out branch was cut from `origin/main`, and a sibling branch's commits landed on `origin/main` between the two
- **THEN** the patchset's base is the merge-base with `origin/main`, its files are the branch's own, and none of the sibling's paths appear

#### Scenario: Branch-row capture on a branch cut past a stale local primary

- **WHEN** the project's primary branch is `main`, local `main` is behind `origin/main`, and the clicked branch was cut from `origin/main`
- **THEN** the branch-range patchset's base is the merge-base with `origin/main`, and the row's ahead count and diffstat describe the same range

#### Scenario: Working-tree capture where the local primary is the newer spelling

- **WHEN** local `main` is ahead of `origin/main` and the checked-out branch was cut from local `main`
- **THEN** the patchset's base is the merge-base with `main`, and `baseRef` records `main`

#### Scenario: A capture measured against a remote-tracking spelling opens its pull request against the branch name

- **WHEN** a patchset records `origin/main` as its `baseRef` and the reviewer opens a pull request from it
- **THEN** the submission and its preview name `main` as the base, and a branch genuinely called `origin/thing` in a clone with no remote named `origin` is submitted as `origin/thing`

#### Scenario: Board storage exists in a repository without an ignore rule

- **WHEN** capture runs in a repository that does not ignore `.rennet/` and app-owned files exist under `.rennet/boards/`
- **THEN** the captured patchset's files, raw diff, and derived identity contain no `.rennet/boards/` content

#### Scenario: Tracked project content lives under .rennet

- **WHEN** the repository intentionally tracks a file under `.rennet/` outside `boards/` and that file changed
- **THEN** the change is captured like any other tracked change
