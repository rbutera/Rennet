# attention-notifications Specification

## Purpose
The daemon's attention system: which events raise attention, which become pushes for which client, how pushes reach a phone, and how attention clears — the closed taxonomy from the mobile ideation doc, delivered presence-aware.
## Requirements
### Requirement: The taxonomy is closed

Exactly six event families SHALL raise attention: turn needs you (ask pending), review finished, turn failed or interrupted, handoff run completed, publish-ready, and processing finished. Each SHALL carry its substance (the ask's question, the review's finding counts, the failure's truthful cause) and its deep-link target. Nothing else pushes.

#### Scenario: no push outside the taxonomy

- **WHEN** any daemon event outside the six families occurs
- **THEN** no push is sent for it

### Requirement: Delivery is presence-aware per client

For each attention event and each registered client, the daemon SHALL decide between a live in-app event and a push using the client's reported presence: a client connected and focused on the affected review receives the live event only; every other registered client receives the push. High-priority families (ask pending, review finished, failure) SHALL always reach every client one way or the other.

#### Scenario: focused client is not pushed

- **WHEN** a review finishes while a client is connected with focus on that review
- **THEN** that client gets the live event and no push, while a backgrounded phone gets the push

### Requirement: Push tokens register per paired device

A token-bearing client SHALL be able to register (and replace, and delete) a push token for its device over the protocol. The daemon SHALL post pushes for that device to the push service as an outbound call, SHALL treat push-service failure as non-fatal (the in-app event still flows), and SHALL drop tokens the service reports as dead. Revoking a device's pairing SHALL delete its push token.

#### Scenario: revoke stops pushes

- **WHEN** a device's pairing is revoked from any client
- **THEN** no further push is posted to that device's token

### Requirement: Attention clears on view

Attention flags SHALL clear when a client views the linked surface (or acts on the event), and the clearing SHALL propagate to every client so a handled item does not keep demanding attention elsewhere.

#### Scenario: handled once, quiet everywhere

- **WHEN** the user opens a pushed review's digest on the phone
- **THEN** the attention flag clears on the daemon and other clients' needs-you badges for it disappear

### Requirement: Presence consumption is capability-gated

The daemon SHALL advertise attention/presence support in its handshake capabilities; presence frames from clients SHALL be accepted only then, and the delivery planner SHALL treat a client that never reports presence as away (push-eligible). Daemons and clients from before this capability SHALL interoperate unchanged.

#### Scenario: old client, new daemon

- **WHEN** an M0-era client that sends no presence connects
- **THEN** commands and streams behave as before and the client is simply treated as away for delivery decisions

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

