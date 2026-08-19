# mobile-shell Specification (delta)

## ADDED Requirements

### Requirement: A live turn is watchable and stoppable

The app SHALL render a running turn's ask stream as a typed timeline that follows the live tail, offers a return-to-tail control when the user scrolls up, and shows a visible Stop that interrupts the turn. Entering the screen SHALL paint persisted turn state first (reattach), then follow the live stream; a mid-turn network change SHALL NOT lose the stream (the runtime rebinds) or render the turn as hung.

#### Scenario: stream survives backgrounding mid-turn

- **WHEN** the user backgrounds the app during a streaming turn, switches networks, and returns
- **THEN** the timeline catches up and continues live without a consumer re-subscribe, and no event renders twice

#### Scenario: stop is one visible tap

- **WHEN** the user taps Stop during a running turn
- **THEN** the turn interrupts and the timeline states the interrupted outcome truthfully

### Requirement: Asks are answered with decision plus direction

An ask SHALL render its question with its answer chips and an optional free-text field; a chip alone, text alone, or both together SHALL compose into one reply. Send semantics while a turn runs SHALL be explicit (send interrupts; hold to queue). Drafts SHALL persist per review across navigation.

#### Scenario: chip plus redirection in one reply

- **WHEN** the user taps an answer chip and adds free text before sending
- **THEN** exactly one reply carries both the decision and the direction

### Requirement: Posting is one un-ceremonied tap

The publish flow SHALL show the preview — the collated outbound review, its verdict, and its destination — and one tap SHALL post it; the posted screen SHALL state the real URL, and a retry or double tap SHALL yield exactly one posted review (or one PR on the own-branch path, drafted body included). "Ask for changes" SHALL route to a refine turn; the phone SHALL NOT offer text-editing of the outbound review. There SHALL be no sign step, no biometric ritual, and no confirmation dialog.

#### Scenario: exactly one post

- **WHEN** the user taps post twice or retries over a flaky connection
- **THEN** exactly one review (or one PR) exists at the destination and the app shows its real URL

#### Scenario: not right means refine, not edit

- **WHEN** the preview is not what the user wants to post
- **THEN** the offered action is a refine turn (ask for changes), never a phone text editor

### Requirement: Reviews kick off from the phone

The app SHALL start a team-PR review from a pasted PR link and from the OS share sheet (a GitHub PR URL shared to Rennet), and an own-branch pre-submit review from the daemon's branch list; kickoff progress SHALL stream live and the new review SHALL appear in the list.

#### Scenario: share-sheet to running review

- **WHEN** the user shares a GitHub PR URL to Rennet from another app
- **THEN** the app opens on the kickoff surface with the link applied and the review starts on the daemon
