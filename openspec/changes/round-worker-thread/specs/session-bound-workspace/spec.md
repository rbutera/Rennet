## MODIFIED Requirements

### Requirement: A coding round is a turn on the bound workspace

A coding round SHALL execute as one turn on its OWN sidecar thread, created for that round in the session's bound workspace. Its commits SHALL land on the session's branch. That thread's per-turn checkpoint SHALL be the round's receipt, and the review SHALL advance to a new patchset captured from the bound workspace after the turn. Rennet SHALL NOT create a detached worktree per round, SHALL NOT replay a worker delta onto the source branch, SHALL NOT stage untracked files with a blanket add on the reviewer's behalf, and SHALL NOT run the repository's configured check command itself.

#### Scenario: Round commits land on the branch

- **WHEN** a round's worker completes with commits
- **THEN** those commits are on the session's branch in the bound workspace and the round account names the checkpoint that captured them

#### Scenario: No worktree per round

- **WHEN** three rounds run on one session
- **THEN** no round worktree exists under the data directory and the session's bound root is the only workspace touched

#### Scenario: The round has its own transcript

- **WHEN** a round is dispatched on a session whose chat thread already exists
- **THEN** the round's turn is sent to a thread created for that round, and the session's chat thread receives no turn

#### Scenario: Rennet runs no check of its own

- **WHEN** a round's turn settles
- **THEN** Rennet's next action is to observe the commits the turn left, with no process of its own started in the bound workspace in between
