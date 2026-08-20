# Mobile shell specification

## Purpose
Define the native mobile app that pairs with Rennet daemons, reads and acts on complete reviews at phone width, and opens notification links at the relevant review state. The app consumes the client projection and authenticates with device tokens.
## Requirements
### Requirement: Pairing bootstraps by QR, link, or code

The app SHALL pair with a daemon by scanning its QR code, pasting a pairing link, or typing a one-time code. It SHALL exchange the bootstrap value for a device token and store that token in the platform keychain. Later opens SHALL reconnect without another pairing step.

#### Scenario: scan to paired

- **WHEN** the user scans a valid pairing QR from their desktop
- **THEN** the app exchanges the code, stores the device token in the platform keychain, and the daemon appears in the connections list as reachable

#### Scenario: typed fallback

- **WHEN** the camera cannot scan and the user types the one-time code
- **THEN** pairing succeeds identically

### Requirement: Connections list tells the truth

The connections list SHALL show every paired daemon with its live reachability (from the shared runtime's state machine), the harnesses the daemon disclosed, and this device's revocable token. An unreachable daemon SHALL remain listed with its last replica readable, never blank; a revoked token SHALL surface as the terminal error state, not silent retry.

#### Scenario: unreachable daemon degrades readable

- **WHEN** a paired daemon is unreachable at open
- **THEN** its row reads offline, its reviews render from the last replica with a staleness mark, and nothing pretends to be live

### Requirement: The review list is status-first across daemons

The home list SHALL aggregate reviews across all paired daemons, pin running and needs-you reviews to the top, group the rest by recency, and show freshness and disposition as row facts. On open it SHALL paint from the stored replica instantly and reconcile once online.

#### Scenario: replica-instant open

- **WHEN** the app opens with a previously synced daemon unreachable
- **THEN** the review list renders immediately from the replica with the offline state visible

#### Scenario: needs-you pins

- **WHEN** any review has a pending ask or attention flag
- **THEN** its row is pinned above the recency groups with a needs-you badge

#### Scenario: cold open is truthful about needs-you

- **WHEN** the app opens against an attention-capable daemon and a review has a mid-turn ask that no push has yet delivered
- **THEN** the projected review's additive `attention.needsYou` (sourced from the daemon's attention system) pins the row on the first paint, and against a daemon that predates the capability the app falls back to deriving needs-you from the flagged queue plus live events

### Requirement: The whole review is readable on the phone

Review detail SHALL lead with the delta digest and its new, resolved, and carried rows. It SHALL open findings one at a time with the claim, hunk, disposition actions, and proposal adjudication. It SHALL render every sequence cohort, finding, and hunk in reading order, using virtualization to keep the list responsive through the last line. The phone SHALL NOT refer the user to the desktop to finish reading.

#### Scenario: read to the last hunk

- **WHEN** the user opens the full canvas of a large finished review
- **THEN** they can scroll every finding and hunk to the end without the app dropping the session or truncating content

#### Scenario: judgement round-trips

- **WHEN** the user sets a disposition on a finding from the phone
- **THEN** the disposition persists on the daemon and is visible from any other client

### Requirement: Pushes land on the decision surface

The app SHALL register for push notifications with each paired daemon, and a received push SHALL deep-link to the surface its taxonomy entry names (review finished → that review's digest; needs-you → the review's ask context; failure → the review's error state; publish-ready → the publish preview; processing → project detail). Opening the linked surface SHALL clear the attention flag. A notification settings screen SHALL present the closed taxonomy as per-event switches.

#### Scenario: backgrounded push deep-links

- **WHEN** a "review finished" push arrives while the app is backgrounded and the user taps it
- **THEN** the app opens directly on that review's delta digest and the attention flag clears

### Requirement: The app consumes only the projection

Every read and write SHALL use the projected client contract with the device token. The app SHALL never receive or display a host-absolute path and SHALL NOT use a side channel outside the protocol connection.

#### Scenario: paths render as references

- **WHEN** a review's finding names a file
- **THEN** the app shows the repo reference display name and relative path, never a host-absolute path

### Requirement: A live turn is watchable and stoppable

The app SHALL render a running turn's ask stream as a typed timeline that follows the live tail, offers a return-to-tail control when the user scrolls up, and shows a visible Stop that interrupts the turn. Entering the screen SHALL paint persisted turn state first (reattach), then follow the live stream; a mid-turn network change SHALL NOT lose the stream (the runtime rebinds) or render the turn as hung.

#### Scenario: stream survives backgrounding mid-turn

- **WHEN** the user backgrounds the app during a streaming turn, switches networks, and returns
- **THEN** the timeline catches up and continues live without a consumer re-subscribe, and no event renders twice

#### Scenario: stop is one visible tap

- **WHEN** the user taps Stop during a running turn
- **THEN** the turn interrupts and the timeline states the interrupted outcome truthfully

### Requirement: Asks are answered with decision plus direction

An ask SHALL render its question, answer chips, and an optional free-text field. A chip, text, or both SHALL compose into one reply. While a turn runs, the primary send action SHALL interrupt it and a secondary send action SHALL submit without interrupting. Drafts SHALL persist per review across navigation.

#### Scenario: chip plus redirection in one reply

- **WHEN** the user taps an answer chip and adds free text before sending
- **THEN** exactly one reply carries both the decision and the direction

### Requirement: Posting is one un-ceremonied tap

The publish flow SHALL preview the collated outbound review, its verdict, and its destination. One tap SHALL post it. The posted screen SHALL show the returned URL, and a retry or double tap SHALL produce exactly one review or own-branch pull request. An own-branch pull request SHALL include the drafted body. "Ask for changes" SHALL start a refinement turn. The phone SHALL NOT offer direct editing of the outbound review or insert an extra confirmation step.

#### Scenario: exactly one post

- **WHEN** the user taps post twice or retries over a flaky connection
- **THEN** exactly one review (or one PR) exists at the destination and the app shows its real URL

#### Scenario: not right means refine, not edit

- **WHEN** the preview is not what the user wants to post
- **THEN** the offered action is a refine turn (ask for changes), never a phone text editor

### Requirement: Reviews kick off from the phone

The app SHALL start a team-PR review from a pasted PR link and an own-branch pre-submit review from the daemon's branch list. Kickoff progress SHALL stream live, and the new review SHALL appear in the list. Android SHALL also accept a GitHub PR URL from the operating system share sheet. The iOS share extension remains planned under [issue #383](https://github.com/rbutera/rennet/issues/383).

#### Scenario: share-sheet to running review

- **WHEN** an Android user shares a GitHub PR URL to Rennet from another app
- **THEN** the app opens on the kickoff surface with the link applied and the review starts on the daemon
