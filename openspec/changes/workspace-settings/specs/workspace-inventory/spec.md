## ADDED Requirements

### Requirement: The settings surface lists every workspace Rennet knows for a repository

For the scoped repository, the Worktrees section SHALL list each workspace Rennet knows — the reviewer's own checkout while a session is bound to it, each branch worktree, each sibling worktree, each pull-request snapshot — with its path, its ref, the sessions bound to it, when it was made, when it was last used, and its size. Size SHALL be computed on request under a stated time bound and SHALL read as unknown, not zero, when the bound is exceeded. The list SHALL be keyed by repository path, never by project id, so a workspace project's repositories are listed separately.

The reviewer's own checkout SHALL be the scoped repository's own root and only that: a project rooted at a linked worktree SHALL list that worktree as the reviewer's own, and the repository's main worktree SHALL be listed only when a live session is bound to it, as the branch worktree it is.

#### Scenario: A bound session appears
- **WHEN** a session is bound to the reviewer's own checkout
- **THEN** the checkout is listed as the reviewer's own, naming the session, with no remove action

#### Scenario: A project rooted at a linked worktree
- **WHEN** the scoped repository's root is a linked worktree rather than the repository's main one
- **THEN** exactly one row reads as the reviewer's own checkout, and it is that worktree

#### Scenario: An ahead sibling says so
- **WHEN** a sibling holds commits the reviewed branch lacks
- **THEN** its row reads ahead by that many commits

#### Scenario: A sibling whose reviewed branch is gone says its branch is kept
- **WHEN** a sibling's reviewed branch no longer exists, so there are no commits to count against it
- **THEN** its row says removing it keeps the sibling branch, and why

#### Scenario: Size past the bound
- **WHEN** a worktree's size cannot be measured within the bound
- **THEN** the size cell reads as unknown rather than zero

### Requirement: An idle Rennet-made workspace is removed on request, never forced

A Rennet-made workspace with no live session SHALL carry a remove action that runs git's worktree removal without force. The sibling collection rule SHALL decide the sibling BRANCH only: a sibling whose tip is reachable from the reviewed branch or its remote-tracking ref SHALL have its branch deleted with its worktree, and a sibling holding commits the reviewed branch lacks SHALL keep its branch, which the outcome names. The removal SHALL address a row by an opaque identifier the list issued, never by a path, so a projected client can remove a workspace whose host path it has never been given. A refusal git returns SHALL be shown verbatim on the row, with the directory left as it was — verbatim to a local client, and to a projected one with every absolute path outside the known roots and the home directory redacted, as R19 already requires of the display transcript. The action SHALL complete in one interaction with no confirmation step.

Only the AUTOMATIC collection — a session archived, or the startup sweep — keeps both the worktree and the branch of an unmerged sibling, because nobody asked it for anything. That rule lives with the sibling requirement in `session-bound-workspace`.

#### Scenario: Clean removal
- **WHEN** the reviewer removes an idle branch worktree with a clean tree
- **THEN** the worktree is gone and the row disappears

#### Scenario: Refused removal
- **WHEN** the reviewer removes an idle worktree holding uncommitted changes
- **THEN** git's refusal is shown on the row and the directory is untouched

#### Scenario: An ahead sibling loses its worktree and keeps its branch
- **WHEN** the reviewer removes an idle sibling worktree whose branch holds commits the reviewed branch lacks
- **THEN** the worktree is gone, the sibling branch still holds those commits, and the outcome names the branch it kept and how far ahead it is
