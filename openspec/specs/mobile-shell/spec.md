# mobile-shell Specification

## Purpose
The native mobile app's first shippable cut: pair with daemons, triage and read reviews completely at phone width, and land from pushes on the right surface — a full peer within its locus, consuming the R19 projection and device tokens exclusively.
## Requirements
### Requirement: Pairing bootstraps by QR, link, or code

The app SHALL pair with a daemon by scanning the desk-minted QR, pasting a pairing link, or typing the one-time code, exchanging it for a device token stored in the platform keychain. Pairing is connection bootstrap, not a consent ceremony: after one successful pairing the daemon just works on every later open.

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

Review detail SHALL lead with the delta digest (new / resolved / carried counts and rows), open findings one at a time (claim, hunk, one-tap agree/disagree/discuss, proposal adjudication), and SHALL render the full sequence canvas — every cohort, finding, and hunk in reading order — virtualized so it stays responsive to the last line. The digest is the entry point, never a boundary; no screen refers the user to a desktop to finish reading.

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

Every read and write SHALL go through the R19 projected contract with the device token; the app SHALL never receive or display a host-absolute path, and SHALL NOT use any side channel beyond the protocol connection.

#### Scenario: paths render as references

- **WHEN** a review's finding names a file
- **THEN** the app shows the repo reference display name and relative path, never a host-absolute path

