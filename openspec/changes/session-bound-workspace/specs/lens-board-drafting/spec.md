## ADDED Requirements

### Requirement: The Design lens drafts from the spec it finds, or settles absent

The Design seat SHALL receive no discovered artifact bundle. Its instructions SHALL tell it to find the specification for the reviewed branch in the bound workspace if one exists — an OpenSpec change, a BMAD, Kiro, grill-me or superpowers document, an ADR — using the reviewed range's commit messages and the pull request body as the clue, and to draft the Design board from what it finds. When it finds none, the lane SHALL settle as an absence with the reason that no spec was found for this branch; the bench reader SHALL state that reason, and the finished board views SHALL carry no Design tab. An empty or invented Design board SHALL NOT be drafted.

#### Scenario: The branch has an OpenSpec change
- **WHEN** the reviewed range's commits name an OpenSpec change that exists in the workspace
- **THEN** the Design board is drafted from that change's artifacts and cites them by path

#### Scenario: No spec exists
- **WHEN** the seat finds no specification for the reviewed branch
- **THEN** the Design lane settles absent with "no spec found for this branch", the bench reader says so, and the board views show no Design tab

## MODIFIED Requirements

### Requirement: A lens seat settles within the canonical outcome domain

Every lens seat (Sequence, Decisions, Flagged, Noise, Design) SHALL settle in exactly one state drawn from the existing durable lens domain (board / absence / failure, as `lensBoards` / `absentLenses` / `failedLenses` already model): a semantically accepted populated board, a typed absence with a reason admissible for that specific lens (Noise admits `no-noise`; Design admits `no-spec`; Sequence admits no absence), or a typed failure account naming the lens, the attempt, and a retryable/terminal classification. This SHALL extend the canonical settlement domain, not introduce a parallel one. A seat SHALL never settle silently with no board, no absence, and no failure account.

#### Scenario: Drafting turn emits no board

- **WHEN** a lens seat's drafting turn completes without emitting a board
- **THEN** the non-emission seeds the lint ladder exactly as an unparseable return does and the seat is re-asked, so a lane never settles silently

#### Scenario: Design settles absent on a branch with no spec

- **WHEN** the Design seat reports that no specification exists for the branch
- **THEN** the lane settles as a `no-spec` absence, not as a failure and not as an empty board

### Requirement: Emitted board references are admitted by the target document without losing material

A lens seat SHALL emit only references that the exact board document it writes admits, and every code reference SHALL be a path plus a line range on one side of the change. Reference validity SHALL be established at the producer/composition boundary before the write, by resolving each citation against the captured patchset. An inadmissible reference SHALL be repaired only when its unique intended target is provable; otherwise the lane SHALL retry or settle as a typed failure. A repair on any leg SHALL carry only the violation pointers and the frozen element ids, never the base instructions or the failing draft. An element SHALL NOT be silently dropped to make a board acceptable — an accepted board that omits produced material without account is a defect. The board service remains authoritative and SHALL continue to reject invalid elements rather than admit them.

#### Scenario: Producer emits a provably re-anchorable reference

- **WHEN** a drafting turn produces an element whose reference is inadmissible but whose unique intended target is provable from the captured patchset
- **THEN** the boundary repairs the reference with a recorded account and the board service admits the element

#### Scenario: A repair carries pointers only

- **WHEN** a draft fails lint on an ephemeral leg or a sidecar seat
- **THEN** the follow-up turn carries the pointers and frozen ids and nothing of the base prompt or the draft

## REMOVED Requirements

### Requirement: Live drafting populates the core lenses on a real branch

**Reason**: Superseded by the measured drives of `t3-lens-threads` task 1.6 and by the Design lens respec; the requirement named Sequence and Decisions only and assumed the artifact-bundle Design lens.

**Migration**: The live proof is the drive recorded in `docs/developing/concepts/t3code-sidecar.md`; the Design behaviour is now "drafts from the spec it finds, or settles absent" above.
