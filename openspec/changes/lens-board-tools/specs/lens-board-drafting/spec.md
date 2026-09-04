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

## ADDED Requirements

### Requirement: The Noise board is the complement of the other lens boards

Noise SHALL be a position, not a property of a hunk: a changed region no other lens board cites is noise, and a changed region another lens board cites is not. Membership of the Noise board SHALL be DERIVED by the host as the complement of the Design, Sequence, Decisions and Flagged boards' citations over the captured patchset, and SHALL NOT be a seat's judgement about reading effort. The host SHALL place one member per uncited changed region on the Noise board before the Noise seat's first turn.

The complement SHALL be total. No member SHALL be added, removed, or handed to another lens: a seat SHALL have no verb that creates a member and none that removes one, so the board and the change agree by construction rather than by diligence.

What the seat SHALL author is the account the derivation cannot give. Every member SHALL be parented into exactly one group that names its pattern, and every group SHALL carry a reason specific to this change rather than a general statement about that kind of file. A member the seat judges the reviewer must read anyway SHALL remain on the board and carry a `signal` verdict naming what to look at, because the remainder is total and there is nowhere else for it to go.

A member's judge mark SHALL record how its VERDICT was reached — derived by the host, or changed by the seat — and SHALL NOT be read as a statement about how its membership was decided, which is always derivation.

#### Scenario: A region no other board cited

- **WHEN** the four other lens boards have settled and a changed region of the patchset is cited by none of them
- **THEN** that region is a member of the Noise board, placed by the host, without any seat having judged it

#### Scenario: A region another board cited

- **WHEN** the Flagged board cites a changed region
- **THEN** that region is not a member of the Noise board, whatever its content looks like

#### Scenario: A seat cannot change the membership

- **WHEN** the Noise seat attempts to add a member or to remove one the host placed
- **THEN** there is no verb that adds one and the removal is refused, and the board still accounts for every uncited region

#### Scenario: A leftover region the reviewer must read

- **WHEN** the seat judges that a member is not safe to take on trust
- **THEN** it stays on the board, its verdict reads `signal` with a reason naming what to look at, and its judge mark says the seat reached that verdict

### Requirement: The Noise lane runs on its siblings' settlements and never on their silence

The Noise lane SHALL start only once the Design, Sequence, Decisions and Flagged lanes have all reached a terminal state, because the complement of a board that has not settled is not knowable. No other lane SHALL wait on Noise, and the Noise lane SHALL NOT delay the reveal of any other board.

A lane that settled a board or declared an admissible absence has POSITIVELY stated what it cites, and an absence SHALL be subtracted as an empty citation set. A lane that FAILED has stated nothing, and its silence SHALL NOT be treated as an empty citation set. When any of the four has failed, the Noise lane SHALL NOT settle a noise board: it SHALL settle as a typed failure naming the lanes whose citations are unknown and why the complement cannot be taken, and it SHALL become runnable again when such a lane settles on retry. A complement taken over a partial set of siblings SHALL NOT be presented as noise.

When the derived complement is empty, the lane SHALL settle its admissible absence WITHOUT running a seat, and that settlement SHALL mean that the other four lanes between them cited every changed region.

#### Scenario: Noise starts on the four settlements

- **WHEN** the four other lanes have settled and the Noise lane has not started
- **THEN** the Noise lane starts against their citations, and no other lane waited for it

#### Scenario: A sibling lane failed

- **WHEN** the Flagged lane settles as a typed failure and the other three settle
- **THEN** the Noise lane settles as a typed failure naming Flagged as the lane whose citations are unknown, and no board calls Flagged's un-cited regions noise

#### Scenario: A sibling declared an absence

- **WHEN** the Decisions lane settles `no-decisions` and the other three settle boards
- **THEN** the complement is taken with Decisions contributing no citations, and the Noise lane settles a board

#### Scenario: Every region was cited

- **WHEN** the four settled boards between them cite every changed region of the patchset
- **THEN** the Noise lane settles its absence without a seat turn, and the reader is told that every changed region is on another board
