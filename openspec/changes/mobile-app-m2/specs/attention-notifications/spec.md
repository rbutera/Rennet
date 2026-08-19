# attention-notifications Specification (delta)

## ADDED Requirements

### Requirement: An ask push is answerable from the shade

The ask-pending push SHALL carry the ask's answer chips as notification actions; choosing one SHALL deliver that answer to the daemon as the same reply the app would send, without the app opening. The action's outcome SHALL be truthful: on success the attention clears everywhere; on failure (daemon unreachable, turn superseded) the notification updates to say the answer did not land and deep-links into the ask.

#### Scenario: answered without opening the app

- **WHEN** the user picks an answer chip on the lock-screen ask notification
- **THEN** the daemon receives it as the turn's reply, the turn proceeds, and the attention flag clears on every client

#### Scenario: a failed shade answer tells the truth

- **WHEN** the shade answer cannot reach the daemon or the turn was already answered
- **THEN** the user is told it did not land and is deep-linked to the ask, and no answer is silently dropped or duplicated

### Requirement: The handoff and publish families are live

Handoff-run-completed SHALL raise from the real handoff run outcome (with the delta summary as substance) and publish-ready SHALL raise when a composed draft awaits the user's post (destination and title as substance); each clears on its taxonomy terms (viewing the landing, or the post happening). With these, every family of the closed taxonomy is raised from a real lifecycle.

#### Scenario: publish-ready push lands on the preview

- **WHEN** a draft is composed and waiting while the user is away
- **THEN** a publish-ready push arrives, deep-links to the publish preview, and posting (from any client) clears it everywhere
