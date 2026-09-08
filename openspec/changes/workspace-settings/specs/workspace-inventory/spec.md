## ADDED Requirements

### Requirement: The settings surface lists every workspace Rennet knows for a repository

For the scoped repository, the Worktrees section SHALL list each workspace Rennet knows — the reviewer's own checkout while a session is bound to it, each branch worktree, each sibling worktree, each pull-request snapshot — with its path, its ref, the sessions bound to it, when it was made, when it was last used, and its size. Size SHALL be computed on request under a stated time bound and SHALL read as unknown, not zero, when the bound is exceeded. The list SHALL be keyed by repository path, never by project id, so a workspace project's repositories are listed separately.

#### Scenario: A bound session appears
- **WHEN** a session is bound to the reviewer's own checkout
- **THEN** the checkout is listed as the reviewer's own, naming the session, with no remove action

#### Scenario: An ahead sibling says so
- **WHEN** a sibling holds commits the reviewed branch lacks
- **THEN** its row reads ahead by that many commits

#### Scenario: Size past the bound
- **WHEN** a worktree's size cannot be measured within the bound
- **THEN** the size cell reads as unknown rather than zero

### Requirement: An idle Rennet-made workspace is removed on request, never forced

A Rennet-made workspace with no live session SHALL carry a remove action that runs git's worktree removal without force and applies the sibling collection rule. A refusal git returns SHALL be shown verbatim on the row, with the directory left as it was. The action SHALL complete in one interaction with no confirmation step.

#### Scenario: Clean removal
- **WHEN** the reviewer removes an idle branch worktree with a clean tree
- **THEN** the worktree is gone and the row disappears

#### Scenario: Refused removal
- **WHEN** the reviewer removes an idle worktree holding uncommitted changes
- **THEN** git's refusal is shown on the row and the directory is untouched
