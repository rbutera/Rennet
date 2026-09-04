## MODIFIED Requirements

### Requirement: Core boards reveal progressively as each lane settles

In every generation — initial and post-round — the Sequence, Decisions, and Flagged lanes SHALL start as soon as their inputs are ready (for a post-round regeneration, the verified round report; for the initial generation, the captured patchset), and each lane's board SHALL be visible AS IT IS WRITTEN, element by element, not only once the lane settles. A settled board and an unsettled one SHALL be distinguishable without ambiguity. A slow or failing Design or Noise lane SHALL NOT keep any other lane's content invisible, and no global barrier over all lanes SHALL gate the reveal of anything. While a lane runs, its published state SHALL carry the seat's thread reference and the latest event from that thread, so the surface can show what the seat is doing and open its transcript.

#### Scenario: Design lane is slow while core lanes settle

- **WHEN** Sequence, Decisions, and Flagged settle while the Design lane is still running
- **THEN** the three settled results are visible to the reviewer before the Design lane ends, the Design lane's partial board is readable and marked unsettled, and the Design lane's state names its thread and its latest event

#### Scenario: Elements are visible before their lane settles

- **WHEN** the Sequence seat has written four steps and has not finished
- **THEN** all four are readable on the Sequence board and the board is marked as still being written

#### Scenario: Positive control holds core boards behind a barrier

- **WHEN** a control reintroduces a global all-lanes barrier before reveal
- **THEN** the reveal-timing assertion fails

### Requirement: Generation phases carry distinct durable timings

The system SHALL record distinct durable timings for the round report, each lens lane's draft, repair, and post-process steps, coverage, and reveal — including time-to-first-core-board and time-to-first-element per generation. Time-to-first-core-board keeps its meaning: the first core lane that SETTLED, measured from the moment the reviewer's wait began. Time-to-first-element is a separate figure and SHALL NOT be reported under the other's label. A lane that runs more than one seat SHALL record one draft timing PER SEAT, each naming the harness and model that executed it, so the lane's aggregate span stays derivable while no stage record is left unattributable. The `reveal` timing SHALL end at the last lane that actually revealed a result. The visible phase label SHALL name the phase actually running; lens work SHALL NOT be labeled as report drafting.

#### Scenario: Reviewer inspects a finished regeneration

- **WHEN** a post-round regeneration completes
- **THEN** durable per-phase timings exist for report, each lens lane, coverage, reveal, time-to-first-core-board and time-to-first-element, and no single label absorbed another phase's time

#### Scenario: The dual Flagged lane records both seats

- **WHEN** the Flagged lane runs two harnesses
- **THEN** two draft timings are recorded for that lane, each naming its own harness and model, and the run's dual-model mode is derivable from those records alone

#### Scenario: Positive control mislabels lens work

- **WHEN** a control routes lens-lane time under the report-drafting label
- **THEN** the timing assertion fails

### Requirement: Retry budgets are proportional per lane and attempt

Each lens lane's retry/editor budget SHALL be bounded per lane and per attempt by an explicit table. An attempt SHALL be spent only by a turn that ENDS without its board settled or its lens declared absent; a refused authoring call and a returned whole-board verdict SHALL cost nothing, because the seat answers both inside the turn that caused them. A repeated whole-board attempt SHALL draw the table's repeat entry rather than a silently refreshed full validation-retry ladder. The repeat entry SHALL never exceed the first attempt's, so N restarts cost N bounded attempts; and it SHALL never be zero, because a zero budget ends a lane on one dead turn and the restart recovery exists precisely to re-draft such a lane. A budgeted repair SHALL be a further turn on the lane's existing thread, resuming the board that turn left, never a cold session re-sending the base prompt.

#### Scenario: A turn with many refusals costs one attempt

- **WHEN** a seat's turn has ten authoring calls refused and one whole-board verdict returned, and then settles the board
- **THEN** the lane records one attempt and settles

#### Scenario: Second whole-board attempt on one lane

- **WHEN** a lane's first turn ends unsettled and a second attempt starts
- **THEN** the second attempt runs under the table's bounded repeat budget, no richer than the first attempt's, on the same seat thread, over the board the first turn left

#### Scenario: A repeat attempt hits one dead turn

- **WHEN** a restart's turn dies before settling its board
- **THEN** the lane still has a repair turn and can produce a board, rather than terminating permanently
