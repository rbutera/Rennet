## REMOVED Requirements

### Requirement: A live turn is watchable and stoppable
**Reason**: The turn the phone watched was the `review.ask` orchestrator turn, and that chat is retired (Rai, 2026-09-03). With no ask stream there is nothing to follow, and a Stop that can never reach a running turn is a control that lies.
**Migration**: Watch the review's T3 thread on the desktop. A phone-side thread view is a later change; until then an ask-pending push deep-links to the review's digest rather than to a screen with nothing to send.

### Requirement: Asks are answered with decision plus direction
**Reason**: The reply was one `review.ask` invocation carrying a chip label and/or free text. The command is gone, so the in-app ask card, the notification answer chips, the shade-answer path and the background answer task go with it.
**Migration**: Answer in the review's T3 thread on the desktop. The ask-pending push still arrives and still carries its attention id; it now lands on the review rather than on an answer form.

## MODIFIED Requirements

### Requirement: Pushes land on the decision surface

The app SHALL register for push notifications with each paired daemon, and a received push SHALL deep-link to the surface its taxonomy entry names (review finished → that review's digest; needs-you → the review's digest, because the phone has no conversation surface; failure → the review's error state; publish-ready → the publish preview; processing → project detail). Opening the linked surface SHALL clear the attention flag. A notification settings screen SHALL present the closed taxonomy as per-event switches. A push SHALL NOT carry answer chips, because no phone surface can send an answer.

#### Scenario: backgrounded push deep-links

- **WHEN** a "review finished" push arrives while the app is backgrounded and the user taps it
- **THEN** the app opens directly on that review's delta digest and the attention flag clears

#### Scenario: an ask push lands on the review

- **WHEN** an ask-pending push arrives and the user taps it
- **THEN** the app opens that review's digest, and the notification offers no answer action
