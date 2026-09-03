## MODIFIED Requirements

### Requirement: Core boards reveal progressively as each lane settles

In every generation — initial and post-round — the Sequence, Decisions, and Flagged lanes SHALL start as soon as their inputs are ready (for a post-round regeneration, the verified round report; for the initial generation, the captured patchset), and each semantically accepted board or typed absence SHALL become visible when that lane settles. A slow or failing Design or Noise lane SHALL NOT keep a completed core result invisible, and no global barrier over all lanes SHALL gate the reveal of settled core boards. While a lane runs, its published state SHALL carry the seat's thread reference and the latest event from that thread, so the surface can show what the seat is doing and open its transcript.

#### Scenario: Design lane is slow while core lanes settle

- **WHEN** Sequence, Decisions, and Flagged settle while the Design lane is still running
- **THEN** the three settled results are visible to the reviewer before the Design lane ends, and the Design lane's state names its thread and its latest event

#### Scenario: Initial generation reveals progressively too

- **WHEN** a fresh review's first generation runs and two core lanes settle early
- **THEN** those boards are visible before the remaining lanes or coverage complete

#### Scenario: Positive control holds core boards behind a barrier

- **WHEN** a control reintroduces a global all-lanes barrier before reveal
- **THEN** the reveal-timing assertion fails

### Requirement: Retry budgets are proportional per lane and attempt

Each lens lane's retry/editor budget SHALL be bounded per lane and per attempt by an explicit table. A repeated whole-board attempt SHALL draw the table's repeat entry rather than a silently refreshed full validation-retry ladder. The repeat entry SHALL never exceed the first attempt's, so N restarts cost N bounded attempts; and it SHALL never be zero, because a zero budget ends a lane on one malformed output and the restart recovery exists precisely to re-draft such a lane. A budgeted repair SHALL be a further turn on the lane's existing thread, never a cold session re-sending the base prompt.

#### Scenario: Second whole-board attempt on one lane

- **WHEN** a lane's first board attempt fails and a second whole-board attempt starts
- **THEN** the second attempt runs under the table's bounded repeat budget, no richer than the first attempt's, on the same seat thread

#### Scenario: A repeat attempt hits one malformed output

- **WHEN** a restart's redraft receives an unparseable board on its first turn
- **THEN** the lane still has a repair turn and can produce a board, rather than terminating permanently
