## MODIFIED Requirements

### Requirement: A session binds to exactly one workspace at creation

A session SHALL bind to exactly one workspace root when it is created and SHALL keep that binding for its whole life. Where a Rennet-created worktree is placed SHALL be the location and layout resolved off the settings ladder for the reviewed repository: a root whose builtin is the data directory's `worktrees/`, a branch pattern whose builtin is `{repo}/{branch}`, and a pull-request pattern whose builtin is `{owner}/{name}/pr-{number}`. A pull-request snapshot review SHALL bind to a detached worktree at the reviewed head. A branch review of a branch no worktree has out SHALL bind to a worktree Rennet creates on that branch. A branch review of a branch some worktree already has out SHALL bind according to the repository's resolved `workspace` setting: under `share` (the builtin) to that checkout, creating nothing; under `own` to a worktree Rennet creates on a sibling branch `rennet/<branch>` forked from the branch's head, at the resolved branch pattern applied to the SIBLING's name, leaving the existing checkout untouched. Under `own`, a worktree that is Rennet's own placement for the branch SHALL be bound to as under `share`, because it is not a checkout the reviewer is working in. A repository SHALL have at most one sibling worktree per branch: a session binding where one already exists SHALL bind to it as it stands, changing neither its working tree nor its index. A surviving sibling BRANCH with no worktree SHALL be re-forked from the reviewed branch's head only when its tip is reachable from that branch or from a remote-tracking ref of it, and SHALL otherwise be checked out as it stands. A bind whose computed path is already a worktree of the repository on any other reference SHALL fail with that path and that reference named, creating and checking out nothing. A bind SHALL NOT prune a worktree registration, whether it is placing a branch worktree or a sibling: it SHALL read the repository's registrations, and a registration whose directory is not reachable SHALL fail the bind, naming the path and git's own reason, with nothing created, checked out or pruned. Reachability SHALL be decided by git's own unreachability annotation where the git in hand prints one, and SHALL otherwise be probed at the registration's own path, so that a git too old to annotate does not bind a session to a directory that is gone. A pull-request snapshot's checkout SHALL be replaced only where Rennet identifies it as that snapshot — a detached worktree at a path Rennet's pull-request index records — and SHALL otherwise fail naming the path and what occupies it, so that colliding branch and pull-request layouts cannot delete a workspace the reviewer is working in. A bound root SHALL be recorded in the spelling the daemon addresses the repository by, never in the spelling of the git that answered. The session SHALL record its bound root and its work branch — the branch itself, or the sibling — and both SHALL be visible wherever the session names its branch.

#### Scenario: Branch review on the current checkout
- **WHEN** a reviewer whose repository resolves `workspace: share` starts a review of the branch their checkout is on
- **THEN** the session binds to that checkout, records the branch as its work branch, and no worktree is created

#### Scenario: Branch review on the current checkout under own
- **WHEN** a reviewer whose repository resolves `workspace: own` starts a review of the branch their checkout is on
- **THEN** the session binds to a Rennet-created worktree on `rennet/<branch>` forked from the branch's head, records that sibling as its work branch, and the reviewer's checkout is byte-for-byte unchanged

#### Scenario: A second session on the same sibling
- **WHEN** a session under `own` binds to a branch whose sibling worktree already exists and holds uncommitted work
- **THEN** it binds to that worktree as it stands, and the uncommitted work and the sibling's tip are unchanged

#### Scenario: The branch is out in Rennet's own worktree
- **WHEN** a session under `own` reviews a branch that is checked out in the worktree Rennet placed for it, and in nothing else
- **THEN** the session binds to that worktree and no sibling branch is created

#### Scenario: The sibling's path belongs to another worktree
- **WHEN** the resolved placement puts a session's sibling where a worktree of the repository is already checked out on another reference
- **THEN** the bind fails naming that path and that reference, and that worktree's branch, index and working tree are unchanged

#### Scenario: The sibling's directory is unreachable
- **WHEN** a session under `own` binds to a branch whose sibling worktree is registered but whose directory git cannot reach
- **THEN** the bind fails naming that path and git's reason, and no worktree is created, no branch is written and no registration is pruned

#### Scenario: The branch worktree's directory is unreachable
- **WHEN** a session binds to a branch whose Rennet worktree is registered but whose directory cannot be reached from the daemon's side
- **THEN** the bind fails naming that path and git's reason, and no registration is pruned and no worktree is added over that path

#### Scenario: The git in hand cannot annotate an unreachable registration
- **WHEN** a bind reads a registration on a git that prints no unreachability annotation, and the registration's own path cannot be entered
- **THEN** the bind treats it as unreachable and fails, rather than binding the session to that directory

#### Scenario: A branch worktree occupies the pull request's path
- **WHEN** the resolved pull-request layout puts a snapshot where a worktree of the repository is checked out on a branch
- **THEN** the snapshot is not created there and that worktree's head, branch and working tree are unchanged

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

#### Scenario: The round runs where the session is bound, or nowhere
- **WHEN** a round is dispatched on a session whose bound workspace is not on its work branch
- **THEN** the round fails naming that workspace and that branch, and no other workspace of the repository is used

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

Submitting a pull request SHALL push the session's work branch onto the reviewed branch's name on the remote, `refs/heads/<workBranch>:refs/heads/<branch>`, so a pull request opened from a sibling carries the reviewed branch as its head. It SHALL refuse to push a work branch that is neither the reviewed branch nor exactly its sibling, naming both. It SHALL record the push's destination — the remote and the branch name it landed under — on the session.

Where the work branch has got to SHALL be READ FROM GIT when it is asked for, never stamped on the session: how far the work branch is ahead of the reviewed branch, how far the reviewed branch is behind the recorded destination's remote-tracking ref, whether the work branch's tip is reachable from that ref, and whether the reviewed branch already CONTAINS that tip. The two counts SHALL be read from their own ranges and SHALL NOT stand in for one another: a sentence about the remote SHALL carry the remote's count. Containment, not equal tips, SHALL decide that the work has landed, so that a reviewer who commits or pulls on top of a landing is not told the branch has not moved. That state SHALL be shown wherever the review workspace names the session's branch, SHALL name the remote-tracking ref it was decided against rather than calling it an upstream, and SHALL be re-read after any event that moves those refs — a settled round and a pull-request submission included.

The session SHALL offer a land action that fast-forwards the checkout holding the reviewed branch to the work branch, run inside that checkout with git's fast-forward-only merge. Rennet SHALL NOT force, merge or rebase on the reviewer's behalf, and SHALL NOT add a refusal of its own to the one git makes: a refusal git returns — a diverged branch, a merge that would overwrite uncommitted edits — SHALL be shown verbatim beside the branch name, with no dialog and with the action still offered.

#### Scenario: Push from a sibling
- **WHEN** a pull request is submitted from a session whose work branch is `rennet/feat/x`
- **THEN** the remote's `feat/x` advances to the sibling's tip, the pull request's head is `feat/x`, the local `feat/x` does not move, and the workspace says `feat/x` is behind `origin/feat/x` by the commits THAT REF holds and `feat/x` does not — which is a larger number than the sibling's own once anybody else has pushed

#### Scenario: The branch catches up
- **WHEN** the reviewed branch reaches the work branch's tip, by landing or by a pull
- **THEN** the workspace says nothing about the work branch, because the state is read from the refs rather than from a record of the push

#### Scenario: The reviewer carries on after landing
- **WHEN** the reviewed branch has landed the work branch and then moved on by a commit of its own
- **THEN** the workspace still says nothing about the work branch, because the branch contains it

#### Scenario: Push under share is unchanged
- **WHEN** a pull request is submitted from a session whose work branch is the reviewed branch
- **THEN** the refspec is `refs/heads/<branch>:refs/heads/<branch>`, exactly as before

#### Scenario: Landing on a clean checkout
- **WHEN** the reviewer lands a sibling onto a checkout with a clean tree that has not diverged
- **THEN** the checkout's branch fast-forwards to the sibling's tip and its index and working tree carry only that change

#### Scenario: Landing carries unrelated uncommitted work across
- **WHEN** the reviewer lands a sibling onto a checkout holding uncommitted changes the fast-forward does not touch
- **THEN** the branch fast-forwards, those changes are still uncommitted in the tree, and Rennet refuses nothing

#### Scenario: Landing is refused by git
- **WHEN** the reviewer lands a sibling onto a checkout that has commits the sibling lacks, or whose uncommitted edits the fast-forward would overwrite
- **THEN** nothing in the checkout changes, git's refusal is shown beside the sibling's name, and the action remains available

### Requirement: A sibling is collected when its work is reachable, and kept otherwise

When a session bound on a sibling is archived, and when the startup sweep finds a sibling whose session is gone, the sibling and its worktree SHALL be removed only when the sibling's tip is reachable from the reviewed branch, locally or through a remote-tracking ref of it — the ref the session's recorded push destination names, or, with no session to ask, any remote's. A sibling with commits the reviewed branch does not have SHALL be kept with its worktree, and the workspace inventory SHALL say it is ahead and by how many commits.

A sibling SHALL NOT be collected while any unarchived session is bound to it. When a sibling IS collected for an archived session, that session's recorded workspace SHALL be cleared, so that un-archiving it binds again rather than resolving to a directory that no longer exists; un-archiving a session whose recorded workspace is missing SHALL clear it for the same reason. Each collection decision SHALL be written to the daemon log, and the startup sweep SHALL report how many siblings it collected and how many it kept.

Rennet SHALL prune worktree registrations only from the daemon-start sweep, and SHALL prune only registrations it placed. A registration SHALL be prunable only when git reports it unreachable, AND it is Rennet's own — its path is under the repository's resolved placement root, or its branch is a `rennet/*` sibling — AND no live session claims it. A claim SHALL be matched by the session's work branch within the same repository, or by comparing the registration's path against every live session's recorded workspace in both the daemon's spelling and git's. A registration that is not Rennet's SHALL never be pruned by Rennet, whether or not git reports it unreachable. Because the prune verb is repository-wide and cannot be scoped to one registration, a repository holding ANY unreachable registration that is not prunable under this rule SHALL NOT be pruned at all on that pass, and the daemon log SHALL name the paths that held it, capped, with the total.

#### Scenario: A reviewer's own unreachable worktree is left alone
- **WHEN** the sweep finds a repository whose only unreachable registration is the reviewer's own worktree, outside the resolved placement root and not on a sibling branch
- **THEN** nothing in that repository is pruned, and the daemon log names that path

#### Scenario: An unreachable Rennet worktree a live session claims
- **WHEN** the sweep finds an unreachable `rennet/*` registration that a live session is bound to, recorded under a different spelling of the same path
- **THEN** nothing in that repository is pruned, and the daemon log names that path

#### Scenario: An unreachable Rennet worktree nothing claims
- **WHEN** the sweep finds an unreachable registration Rennet placed, no live session claims it, and the repository has no other unreachable registration
- **THEN** that registration is pruned and the daemon log says so

#### Scenario: Pushed then archived
- **WHEN** a session on a sibling submitted a pull request and is then archived
- **THEN** the sibling's tip is reachable from the remote-tracking ref that push updated — with no upstream configured for the branch — and the sibling, its worktree and the session's recorded workspace are removed

#### Scenario: Archived while another session works there
- **WHEN** a session bound on a sibling is archived while another unarchived session is bound to the same sibling
- **THEN** the sibling and its worktree are kept, the daemon log says another session is bound to it, and the archived session's recorded workspace is unchanged

#### Scenario: Ahead then archived
- **WHEN** a session on a sibling with two unpushed round commits is archived
- **THEN** the sibling and its worktree remain and the inventory row for it reads ahead by two
