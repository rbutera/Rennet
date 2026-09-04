## MODIFIED Requirements

### Requirement: A lens seat settles within the canonical outcome domain

Every lens seat (Sequence, Decisions, Flagged, Noise, Design) SHALL settle in exactly one state drawn from the existing durable lens domain (board / absence / failure, as `lensBoards` / `absentLenses` / `failedLenses` already model): a semantically accepted populated board, a typed absence with a reason admissible for that specific lens (Noise admits `no-noise`; Design admits `no-spec`; Sequence admits no absence), or a typed failure account naming the lens, the attempt, and a retryable/terminal classification. This SHALL extend the canonical settlement domain, not introduce a parallel one. A seat SHALL never settle silently with no board, no absence, and no failure account.

A seat SHALL reach that settlement by ACTING on the board it was given, not by returning a document: it settles a board by finishing it and settles an absence by declaring one, each as an explicit call. A turn that ends having done neither SHALL leave what it wrote in place and spend one attempt; a lane whose attempts are spent while its board is unfinished SHALL settle as a typed failure naming the lens, the attempts and what the last verdict said — not as an empty board and not as an absence.

#### Scenario: Drafting turn writes nothing

- **WHEN** a lens seat's drafting turn ends having written no element and declared no absence
- **THEN** the lane spends one attempt and the seat is re-asked, so a lane never settles silently

#### Scenario: Design settles absent on a branch with no spec

- **WHEN** the Design seat declares the absence its lens admits
- **THEN** the lane settles as a `no-spec` absence, not as a failure and not as an empty board

#### Scenario: Attempts run out on an unfinished board

- **WHEN** a lane's attempts are spent and its board has never been finished
- **THEN** the lane settles as a typed terminal failure naming the lens, the attempts spent and the last verdict, and the elements the seat did write remain readable

### Requirement: Emitted board references are admitted by the target document without losing material

A lens seat SHALL create only references that the exact board document it writes admits, and every code reference SHALL be a path plus a line range on one side of the change. Reference validity SHALL be established WHERE THE REFERENCE IS MADE — the call that creates it resolves it against the captured patchset and is refused when it does not resolve — so no element carrying an inadmissible reference is ever created, and no repair boundary is needed to re-anchor one. An element SHALL NOT be silently dropped to make a board acceptable — an accepted board that omits produced material without account is a defect. The board service remains authoritative and SHALL continue to reject invalid elements rather than admit them.

Every board seat SHALL run as a turn on its own sidecar thread, and a repair SHALL be the next turn on that thread carrying only the last whole-board verdict — never the base instructions, never the board, never a draft.

#### Scenario: An inadmissible reference is refused where it is made

- **WHEN** a seat cites a range the captured patchset does not cover
- **THEN** the call is refused in the same turn with the nearest changed range, and the board never holds that reference

#### Scenario: A repair carries the verdict only

- **WHEN** a turn ends with a board that did not finish
- **THEN** the follow-up turn on that thread carries the last verdict and nothing of the base prompt or the board

#### Scenario: Positive control restores the production bad-ref shape

- **WHEN** the regression fixture's production `bad-ref` shape is written past the tool boundary
- **THEN** the board service rejects the write, proving the service-side control still fails when the boundary is bypassed
