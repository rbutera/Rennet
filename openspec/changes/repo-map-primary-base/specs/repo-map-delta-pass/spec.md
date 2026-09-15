## MODIFIED Requirements

### Requirement: Baseline movement is detected and coalesced to the newest OID

Rennet SHALL detect when the resolved default-branch OID moves and enqueue a deterministic delta pass for the **newest** OID only. The resolved default-branch OID SHALL be the tip of the primary base as the primary-base-resolution capability defines it: the newest ref in the clone naming the primary branch, whether the name was supplied by the project's recorded primary branch or read from `origin/HEAD`, so that the proactive pass, the initial build and the capture-time pin resolve the same commit. A caller-supplied value that names no branch in the clone (an object id) SHALL resolve verbatim. Detection SHALL be event-driven (a debounced watch of the resolved ref) rather than age-based. A burst of several advances SHALL coalesce to a single pass at the tip; intermediate OIDs SHALL NOT be chased.

#### Scenario: A merge train collapses to one pass

- **WHEN** the default-branch ref advances several times within the debounce window
- **THEN** exactly one delta pass is enqueued, for the tip OID
- **AND** no snapshot is built for any intermediate OID

#### Scenario: No movement, no work

- **WHEN** the watcher fires but the re-resolved base OID equals the stored `manifest.baseOid`
- **THEN** no delta pass is enqueued

#### Scenario: The local primary lags the remote-tracking ref

- **WHEN** the project's primary branch is `main`, local `main` is behind `origin/main`, and the map is resolved by the initial build, by the watcher's re-resolve, and by the capture-time pin
- **THEN** all three resolve `origin/main`'s tip, and a capture does not regenerate a base map the watcher has already built

#### Scenario: The local primary is ahead of the remote-tracking ref

- **WHEN** local `main` is ahead of `origin/main`
- **THEN** the resolved default-branch OID is local `main`'s tip, and `baseRef` reports `main`

#### Scenario: An object id is supplied as the base

- **WHEN** a caller supplies a commit object id rather than a branch name
- **THEN** the resolved OID is that commit, verbatim
