## ADDED Requirements

### Requirement: A coding round runs on its own thread, never the session's

Rennet SHALL create a distinct sidecar thread for each coding round, bound to that round's identity — the session and the round's operation — never to the session's key. The thread SHALL be created with the session's bound workspace as its worktree and the same model selection the review handoff uses, and titled so a reviewer can tell which branch and which round it holds. The round's work order SHALL run as one turn on that thread, and the round's receipt SHALL be that thread's checkpoint for that turn. The session's chat and handoff thread SHALL receive no round turn. Archiving the session SHALL delete its round threads with its other threads.

#### Scenario: A round binds its own thread

- **WHEN** a round is dispatched for a session
- **THEN** a thread bound to that round's identity is created in the session's bound workspace and the work order is sent to it

#### Scenario: The chat thread stays a conversation

- **WHEN** a round runs on a session whose chat thread carries the reviewer's conversation
- **THEN** no turn from that round appears on the chat thread

#### Scenario: The receipt is read from the round's thread

- **WHEN** the daemon restarts while a round's turn is running and then reads the round's receipt
- **THEN** it reads the checkpoint from the round's own thread, and a checkpoint left by any other turn of the session cannot be adopted as this round's

#### Scenario: Archive removes the round threads

- **WHEN** a session with two landed rounds is archived
- **THEN** both round threads are deleted along with the session's chat and seat threads
