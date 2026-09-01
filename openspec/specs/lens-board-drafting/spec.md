# Lens board drafting specification

## Purpose

Define the behavior contract for lens drafting seats: every seat settles with a semantically valid board admitted by the board service, a typed absence admissible for that lens, or an exact typed failure — never a silent absence, never a write the board service must reject, and never an accepted board that silently omits material.

## Requirements

### Requirement: A lens seat settles within the canonical outcome domain

Every lens seat (Sequence, Decisions, Flagged, Noise, Design) SHALL settle in exactly one state drawn from the existing durable lens domain (board / absence / failure, as `lensBoards` / `absentLenses` / `failedLenses` already model): a semantically accepted populated board, a typed absence with a reason admissible for that specific lens (Noise admits `no-noise`; Sequence admits no absence), or a typed failure account naming the lens, the attempt, and a retryable/terminal classification. This SHALL extend the canonical settlement domain, not introduce a parallel one. A seat SHALL never settle silently with no board, no absence, and no failure account.

#### Scenario: Drafting turn emits no board

- **WHEN** a lens seat's drafting turn completes without emitting a board
- **THEN** the non-emission seeds the lint ladder exactly as an unparseable return does and the seat is re-asked, so a later turn's board settles the lens

#### Scenario: No turn in the ladder emits a board

- **WHEN** no turn of a lens seat's ladder — the initial turn or any re-ask — emits a board
- **THEN** the seat records a typed terminal failure naming the lens, the spent attempt count and the original non-emission — not a silent gap, and not a retryable classification for a ladder that has no attempts left — and the run surface reports that exact state

#### Scenario: Signal-only change reaches the Noise seat

- **WHEN** the reviewed change contains no mechanical noise
- **THEN** the Noise seat settles with its first-class admissible absence (`no-noise`), presented as a successful settlement, not a failure

### Requirement: Emitted board references are admitted by the target document without losing material

A lens seat SHALL emit only references that the exact board document it writes admits. Reference validity SHALL be established at the producer/composition boundary before the write. An inadmissible reference SHALL be repaired only when its unique intended target is provable; otherwise the lane SHALL retry or settle as a typed failure. An element SHALL NOT be silently dropped to make a board acceptable — an accepted board that omits produced material without account is a defect. The board service remains authoritative and SHALL continue to reject invalid elements rather than admit them.

#### Scenario: Producer emits a provably re-anchorable reference

- **WHEN** a drafting turn produces an element whose reference is inadmissible but whose unique intended target is provable from the captured patchset
- **THEN** the boundary repairs the reference with a recorded account and the board service receives only admissible references

#### Scenario: Producer emits an unrepairable reference

- **WHEN** an element's reference is inadmissible and no unique target is provable
- **THEN** the lane retries or settles as a typed failure with a recorded account; no board is accepted with that element silently removed

#### Scenario: Positive control restores the production bad-ref shape

- **WHEN** the regression fixture's production `bad-ref` shape is reintroduced past the repair boundary
- **THEN** the board service rejects the write, proving the service-side control still fails when repair is bypassed

### Requirement: Live drafting populates the core lenses on a real branch

A launched-app run against a real harness and a representative local branch SHALL populate Sequence and Decisions with boards whose anchors navigate to the captured immutable patchset, and SHALL settle Noise for both mechanically noisy (populated board) and signal-only (`no-noise` absence) changes.

#### Scenario: Representative change drafts Sequence and Decisions

- **WHEN** live drafting runs against a representative captured change
- **THEN** Sequence and Decisions arrive as accepted boards and their generated anchors resolve into the captured patchset
