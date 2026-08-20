# attention-notifications Specification

## Purpose
Defines which daemon events demand attention, how each client receives them, and when handled events clear across clients.
## Requirements
### Requirement: The taxonomy is closed

Exactly six event families SHALL raise attention: `ask-pending`, `review-finished`, `turn-failed`, `handoff-completed`, `publish-ready`, and `processing-finished`. Each SHALL carry its relevant detail and deep-link target. For example, an ask carries its question, a completed review carries finding counts, and a failed turn carries its cause. No other event SHALL send a push.

#### Scenario: no push outside the taxonomy

- **WHEN** any daemon event outside the six families occurs
- **THEN** no push is sent for it

### Requirement: Delivery is presence-aware per client

For each attention event and registered client, the daemon SHALL choose a live in-app event or a push from the client's reported presence. A client connected and focused on the affected review SHALL receive only the live event. Every other registered client SHALL receive the push. `ask-pending`, `review-finished`, and `turn-failed` SHALL reach every client through one of those routes.

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

The daemon SHALL advertise attention and presence support in its handshake capabilities. It SHALL accept presence frames only when that capability is active. The delivery planner SHALL treat a client that never reports presence as away and eligible for pushes.

#### Scenario: A client sends no presence

- **WHEN** a client sends no presence after connecting
- **THEN** commands and streams remain available and the delivery planner treats the client as away

### Requirement: An ask push is answerable from the shade

The `ask-pending` push SHALL carry the ask's answer chips as notification actions. Choosing one SHALL send the same daemon reply as the app without opening it. On success, attention SHALL clear everywhere. If the daemon is unreachable or the turn has been answered, the notification SHALL state that the answer did not land and deep-link to the ask.

#### Scenario: answered without opening the app

- **WHEN** the user picks an answer chip on the lock-screen ask notification
- **THEN** the daemon receives it as the turn's reply, the turn proceeds, and the attention flag clears on every client

#### Scenario: a failed shade answer tells the truth

- **WHEN** the shade answer cannot reach the daemon or the turn was already answered
- **THEN** the user is told it did not land and is deep-linked to the ask, and no answer is silently dropped or duplicated

### Requirement: The handoff and publish families are live

`handoff-completed` SHALL rise from a handoff run outcome and carry the delta summary. `publish-ready` SHALL rise when a composed draft awaits the user's post and carry the destination and title. Each SHALL clear when the user views its destination or completes the post. Every family in the closed taxonomy SHALL come from a real lifecycle event.

#### Scenario: publish-ready push lands on the preview

- **WHEN** a draft is composed and waiting while the user is away
- **THEN** a publish-ready push arrives, deep-links to the publish preview, and posting (from any client) clears it everywhere
