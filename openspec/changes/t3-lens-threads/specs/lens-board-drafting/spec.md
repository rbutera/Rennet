## MODIFIED Requirements

### Requirement: A lens seat settles within the canonical outcome domain

Every lens seat (Sequence, Decisions, Flagged, Noise, Design) SHALL settle in exactly one state drawn from the existing durable lens domain (board / absence / failure, as `lensBoards` / `absentLenses` / `failedLenses` already model): a semantically accepted populated board, a typed absence with a reason admissible for that specific lens (Noise admits `no-noise`; Sequence admits no absence), or a typed failure account naming the lens, the attempt, and a retryable/terminal classification. This SHALL extend the canonical settlement domain, not introduce a parallel one. A seat SHALL never settle silently with no board, no absence, and no failure account. Each seat's turns SHALL run on that seat's persistent T3 thread, and a re-ask SHALL be a further turn on that thread rather than a fresh session.

#### Scenario: Drafting turn emits no board

- **WHEN** a lens seat's drafting turn completes without emitting a board
- **THEN** the non-emission seeds the lint ladder exactly as an unparseable return does and the seat is re-asked as the next turn on the same thread, so a later turn's board settles the lens

#### Scenario: No turn in the ladder emits a board

- **WHEN** no turn of a lens seat's ladder — the initial turn or any re-ask — emits a board
- **THEN** the seat records a typed terminal failure naming the lens, the spent attempt count and the original non-emission — not a silent gap, and not a retryable classification for a ladder that has no attempts left — and the run surface reports that exact state with the thread still readable

#### Scenario: Signal-only change reaches the Noise seat

- **WHEN** the reviewed change contains no mechanical noise
- **THEN** the Noise seat settles with its first-class admissible absence (`no-noise`), presented as a successful settlement, not a failure
