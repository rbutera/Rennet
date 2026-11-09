# Spec Delta

## ADDED Requirements

### Requirement: Workspace binding failures are classified and actionable

When the bound worktree cannot be created, the session's preparation SHALL fail with a kind (tool missing, large-file checkout, authentication, reference gone, or unknown), a plain-language message, the matching recovery action, and the raw tool output as detail. The failure SHALL be reported at the workspace stage, not mislabelled as a capture failure.

#### Scenario: git-lfs missing
- **WHEN** creating the pull-request worktree fails because the LFS filter cannot run
- **THEN** the preparation fails with kind tool missing naming Git LFS, and the raw git output is kept as detail

#### Scenario: Retry after fixing the cause
- **WHEN** the reviewer installs the missing tool or chooses to skip large files and then activates Retry
- **THEN** preparation runs again and binds the worktree

### Requirement: The front door and the bind agree on the worktree

A failure to create the pull-request worktree when the review is first opened SHALL NOT be silently discarded if the session's bind will need that worktree; both attempts SHALL report the same classified outcome to the session.

#### Scenario: Front-door attempt fails
- **WHEN** the first worktree attempt for a pull request fails
- **THEN** the session's preparation reports that classified failure instead of logging it and failing later with raw text
