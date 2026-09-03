## ADDED Requirements

### Requirement: Every thread is created in the session's bound workspace

Every sidecar thread Rennet creates for a session — the session's chat thread, each lens seat thread, and the handoff thread — SHALL be created with the session's bound workspace as its worktree, never the project root alone. The sidecar's per-turn checkpoints on those threads SHALL be the receipts Rennet reads for a round's commits. A thread created for a session whose bound workspace no longer exists SHALL fail with a message naming the missing path.

#### Scenario: Seat threads share the bound worktree
- **WHEN** a generation starts for a session bound to a worktree
- **THEN** each seat thread's worktree is that path and every seat's tools run there

#### Scenario: Round receipt is a checkpoint
- **WHEN** a round turn on the session's thread completes with commits
- **THEN** the thread's checkpoint for that turn names the commit the round account records
