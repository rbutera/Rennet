## MODIFIED Requirements

### Requirement: A session binds to exactly one workspace at creation

A session SHALL bind to exactly one workspace root when it is created and SHALL keep that binding for its whole life. Where a Rennet-created worktree is placed SHALL be the location and layout resolved off the settings ladder for the reviewed repository: a root whose builtin is the data directory's `worktrees/`, a branch pattern whose builtin is `{repo}/{branch}`, and a pull-request pattern whose builtin is `{owner}/{name}/pr-{number}`. A pull-request snapshot review SHALL bind to a detached worktree at the reviewed head. A branch review of a branch no worktree has out SHALL bind to a worktree Rennet creates on that branch. A branch review of a branch some worktree already has out SHALL bind according to the repository's resolved `workspace` setting: under `share` (the builtin) to that checkout, creating nothing; under `own` to a worktree Rennet creates on a sibling branch `rennet/<branch>` forked from the branch's head, leaving the existing checkout untouched. The session SHALL record its bound root and its work branch — the branch itself, or the sibling — and both SHALL be visible wherever the session names its branch.

#### Scenario: Branch review on the current checkout
- **WHEN** a reviewer whose repository resolves `workspace: share` starts a review of the branch their checkout is on
- **THEN** the session binds to that checkout, records the branch as its work branch, and no worktree is created

#### Scenario: Branch review on the current checkout under own
- **WHEN** a reviewer whose repository resolves `workspace: own` starts a review of the branch their checkout is on
- **THEN** the session binds to a Rennet-created worktree on `rennet/<branch>` forked from the branch's head, records that sibling as its work branch, and the reviewer's checkout is byte-for-byte unchanged

#### Scenario: Branch review of another branch
- **WHEN** a reviewer starts a review of a branch no worktree has out, under either setting
- **THEN** the session binds to a Rennet-created worktree on that branch, placed at the resolved root and branch pattern, and records its path

#### Scenario: Pull-request snapshot
- **WHEN** a reviewer opens a pull request for review, under either setting
- **THEN** the session binds to a detached worktree at the pull request's reviewed head, placed at the resolved root and pull-request pattern

#### Scenario: Untouched settings place nothing differently
- **WHEN** no location, layout or workspace value has been written at any rung
- **THEN** every worktree is placed at the path the previous release placed it at, byte-for-byte

#### Scenario: Two repositories on one branch name in one workspace
- **WHEN** a workspace project holds two repositories both on `feat/x`, both checked out, one resolving `own` and the other `share`
- **THEN** a session on the first binds to a sibling worktree under the first repository's key and a session on the second binds to the second repository's checkout, and neither session's bound root is under the other repository

### Requirement: A coding round is a turn on the bound workspace

A coding round SHALL execute as one turn on its OWN sidecar thread, created for that round in the session's bound workspace. Its commits SHALL land on the session's work branch — the reviewed branch itself, or the sibling when the session was bound under `own` beside an existing checkout. The review SHALL advance to a new patchset captured from the bound workspace after the turn, whose head reference names the reviewed branch and whose head commit is the work branch's tip. That thread's per-turn checkpoint SHALL be the round's receipt. Rennet SHALL NOT create a detached worktree per round, SHALL NOT replay a worker delta onto the source branch, SHALL NOT stage untracked files with a blanket add on the reviewer's behalf, and SHALL NOT run the repository's configured check command itself.

#### Scenario: Round commits land on the branch
- **WHEN** a round's worker completes with commits on a session whose work branch is the reviewed branch
- **THEN** those commits are on that branch in the bound workspace and the round account names the checkpoint that captured them

#### Scenario: Round commits land on the sibling under own
- **WHEN** a round's worker completes with commits on a session whose work branch is `rennet/<branch>`
- **THEN** those commits are on the sibling, the reviewed branch's own ref has not moved, and the review's new patchset names the reviewed branch with the sibling's tip as its head commit

#### Scenario: No worktree per round
- **WHEN** three rounds run on one session
- **THEN** no round worktree exists under the resolved root and the session's bound root is the only workspace touched

#### Scenario: The round has its own transcript
- **WHEN** a round is dispatched on a session whose chat thread already exists
- **THEN** the round's turn is sent to a thread created for that round, and the session's chat thread receives no turn

#### Scenario: Rennet runs no check of its own
- **WHEN** a round's turn settles
- **THEN** Rennet's next action is to observe the commits the turn left, with no process of its own started in the bound workspace in between

## ADDED Requirements

### Requirement: The work branch reaches the reviewed branch by push or by landing

Submitting a pull request SHALL push the session's work branch onto the reviewed branch's name on the remote, `refs/heads/<workBranch>:refs/heads/<branch>`, so a pull request opened from a sibling carries the reviewed branch as its head. The session SHALL offer a land action that fast-forwards the checkout holding the reviewed branch to the work branch, run inside that checkout with git's fast-forward-only merge. Rennet SHALL NOT force, merge or rebase on the reviewer's behalf: a refusal git returns — an unclean tree, a diverged branch — SHALL be shown verbatim beside the branch name, with no dialog and with the action still offered.

#### Scenario: Push from a sibling
- **WHEN** a pull request is submitted from a session whose work branch is `rennet/feat/x`
- **THEN** the remote's `feat/x` advances to the sibling's tip, the pull request's head is `feat/x`, the local `feat/x` does not move, and the round card says the local branch is behind its upstream

#### Scenario: Push under share is unchanged
- **WHEN** a pull request is submitted from a session whose work branch is the reviewed branch
- **THEN** the refspec is `refs/heads/<branch>:refs/heads/<branch>`, exactly as before

#### Scenario: Landing on a clean checkout
- **WHEN** the reviewer lands a sibling onto a checkout with a clean tree that has not diverged
- **THEN** the checkout's branch fast-forwards to the sibling's tip and its index and working tree carry only that change

#### Scenario: Landing is refused by git
- **WHEN** the reviewer lands a sibling onto a checkout with uncommitted changes, or one that has commits the sibling lacks
- **THEN** nothing in the checkout changes, git's refusal is shown beside the sibling's name, and the action remains available

### Requirement: A sibling is collected when its work is reachable, and kept otherwise

When a session bound on a sibling is archived, and when the startup sweep finds a sibling whose session is gone, the sibling and its worktree SHALL be removed only when the sibling's tip is reachable from the reviewed branch, locally or through its remote-tracking ref. A sibling with commits the reviewed branch does not have SHALL be kept with its worktree, and the workspace inventory SHALL say it is ahead and by how many commits.

#### Scenario: Pushed then archived
- **WHEN** a session on a sibling submitted a pull request and is then archived
- **THEN** the sibling's tip is reachable from the branch's remote-tracking ref, and the sibling and its worktree are removed

#### Scenario: Ahead then archived
- **WHEN** a session on a sibling with two unpushed round commits is archived
- **THEN** the sibling and its worktree remain and the inventory row for it reads ahead by two
