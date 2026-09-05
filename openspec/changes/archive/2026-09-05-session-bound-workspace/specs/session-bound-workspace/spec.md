## Purpose

One session, one workspace: a review session binds to a single branch or worktree when it is created, and every model turn the session spawns runs there with that working directory, the way a T3 Code thread does.

## ADDED Requirements

### Requirement: A session binds to exactly one workspace at creation

A session SHALL bind to exactly one workspace root when it is created and SHALL keep that binding for its whole life. A branch review SHALL bind to the user's own checkout when that checkout is on the reviewed branch, and otherwise to a worktree Rennet creates for that branch. A pull-request snapshot review SHALL bind to a worktree at the reviewed head. The bound root SHALL be recorded on the session and SHALL be visible wherever the session names its branch.

#### Scenario: Branch review on the current checkout
- **WHEN** a reviewer starts a review of the branch their checkout is on
- **THEN** the session binds to that checkout and no worktree is created

#### Scenario: Branch review of another branch
- **WHEN** a reviewer starts a review of a branch their checkout is not on
- **THEN** the session binds to a Rennet-created worktree for that branch and records its path

#### Scenario: Pull-request snapshot
- **WHEN** a reviewer opens a pull request for review
- **THEN** the session binds to a worktree at the pull request's reviewed head

### Requirement: Every child of the session runs in the bound workspace

Every model turn the session spawns — each lens seat, the chat thread, the handoff thread, the round worker, and every cold utility turn (scout, repository map, delta digest, coverage, opener, pull-request body, refine, CI classification, finding verification) — SHALL run with the bound root as its working directory. No turn SHALL run in a different checkout, worktree or temporary directory on the session's behalf.

#### Scenario: A seat reads the change from the bound root
- **WHEN** a lens seat runs `git diff` for the review's range
- **THEN** the command runs in the bound root and reads the reviewed tree

#### Scenario: A cold utility turn shares the root
- **WHEN** the coverage turn or the project scout runs for the session
- **THEN** its working directory is the session's bound root

### Requirement: A coding round is a turn on the bound workspace

A coding round SHALL execute as a turn in the session's bound workspace. Its commits SHALL land on the session's branch. The sidecar's per-turn checkpoint SHALL be the round's receipt, and the review SHALL advance to a new patchset captured from the bound workspace after the turn. Rennet SHALL NOT create a detached worktree per round, SHALL NOT replay a worker delta onto the source branch, and SHALL NOT stage untracked files with a blanket add on the reviewer's behalf.

#### Scenario: Round commits land on the branch
- **WHEN** a round's worker completes with commits
- **THEN** those commits are on the session's branch in the bound workspace and the round account names the checkpoint that captured them

#### Scenario: No worktree per round
- **WHEN** three rounds run on one session
- **THEN** no round worktree exists under the data directory and the session's bound root is the only workspace touched

### Requirement: Retired worktrees are removed once

Worktrees created by earlier versions per round operation and per review SHALL be removed by the daemon's startup sweep when no live session references them, and nothing SHALL recreate them.

#### Scenario: Legacy round worktrees on first start
- **WHEN** the daemon starts with round worktrees left by an earlier version
- **THEN** the sweep removes them and reports the count in the daemon log
