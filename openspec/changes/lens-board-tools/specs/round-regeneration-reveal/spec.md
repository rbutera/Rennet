## MODIFIED Requirements

### Requirement: Core boards reveal progressively as each lane settles

In every generation — initial and post-round — the Sequence, Decisions, and Flagged lanes SHALL start as soon as their inputs are ready (for a post-round regeneration, the verified round report; for the initial generation, the captured patchset), and each lane's board SHALL be visible AS IT IS WRITTEN, element by element, not only once the lane settles. A settled board and an unsettled one SHALL be distinguishable without ambiguity. A slow or failing Design or Noise lane SHALL NOT keep any other lane's content invisible, and no global barrier over all lanes SHALL gate the reveal of anything. While a lane runs, its published state SHALL carry the seat's thread reference and the latest event from that thread, so the surface can show what the seat is doing and open its transcript.

The Noise lane is the exception that proves this, and it is a sequencing fact rather than a barrier: its input is the other four lanes' settlements, because its membership is their complement, so it SHALL start when they have settled and it SHALL be the generation's tail. Nothing SHALL wait on Noise. While it waits, its published state SHALL say it is waiting on the lanes it needs — not that it is working, and not that it has failed.

#### Scenario: Design lane is slow while core lanes settle

- **WHEN** Sequence, Decisions, and Flagged settle while the Design lane is still running
- **THEN** the three settled results are visible to the reviewer before the Design lane ends, the Design lane's partial board is readable and marked unsettled, and the Design lane's state names its thread and its latest event

#### Scenario: Noise waits, and nothing waits for Noise

- **WHEN** the Design, Sequence, Decisions and Flagged lanes are still running
- **THEN** the Noise lane has not started, its state says it is waiting on those lanes rather than working or failing, and every one of them reveals its board without waiting for Noise

#### Scenario: Elements are visible before their lane settles

- **WHEN** the Sequence seat has written four steps and has not finished
- **THEN** all four are readable on the Sequence board and the board is marked as still being written

#### Scenario: Positive control holds core boards behind a barrier

- **WHEN** a control reintroduces a global all-lanes barrier before reveal
- **THEN** the reveal-timing assertion fails

### Requirement: Generation phases carry distinct durable timings

The system SHALL record distinct durable timings for the round report, each lens lane's draft, repair, and post-process steps, and reveal — including time-to-first-core-board and time-to-first-element per generation. Coverage SHALL NOT be recorded as a phase of its own: it is no longer a step but the derivation the Noise lane runs on. The Noise lane's span SHALL be measured from the moment its last sibling settled, so the tail it adds to the generation is visible as its own figure rather than buried inside a lane that started earlier. Time-to-first-core-board keeps its meaning: the first core lane that SETTLED, measured from the moment the reviewer's wait began. Time-to-first-element is a separate figure and SHALL NOT be reported under the other's label. A lane that runs more than one seat SHALL record one draft timing PER SEAT, each naming the harness and model that executed it, so the lane's aggregate span stays derivable while no stage record is left unattributable. The `reveal` timing SHALL end at the last lane that actually revealed a result. The visible phase label SHALL name the phase actually running; lens work SHALL NOT be labeled as report drafting.

#### Scenario: Reviewer inspects a finished regeneration

- **WHEN** a post-round regeneration completes
- **THEN** durable per-phase timings exist for report, each lens lane, reveal, time-to-first-core-board and time-to-first-element, the Noise lane's span starts at its last sibling's settlement, no timing is recorded under a coverage phase, and no single label absorbed another phase's time

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

### Requirement: Cross-lens coverage is honest without becoming a reveal barrier

Coverage SHALL be a projection the daemon derives from the boards' citations against the captured patchset, never a gate — and that projection SHALL BE the Noise board rather than a second surface beside it. The changed regions no other lens board cites are the Noise board's members, so the system SHALL NOT carry a coverage state of its own, a coverage phase of its own, or an uncovered count shown anywhere apart from that board. Two names for one set is how a surface comes to tell a reviewer that hundreds of hunks are uncovered beside a board that never mentions them.

No lane SHALL be held, failed or annotated because regions of the change are uncited, and no seat SHALL be asked to account for regions it did not cite. Where the reviewer is shown what the other boards left over, they SHALL be shown it as the Noise board — grouped, reasoned, and reachable — and nowhere else.

#### Scenario: Boards reveal regardless of what is uncited

- **WHEN** the four core lanes settle and much of the change is cited by none of them
- **THEN** every settled board is revealed at once, nothing is held or flagged for it, and the uncited regions become the Noise board's members

#### Scenario: The uncited regions have exactly one home

- **WHEN** the reviewer looks for what the boards did not cite
- **THEN** they find it on the Noise board, and no other surface reports a coverage state or an uncovered count

### Requirement: Reveal state is durable and reconstructable

Per-lane settlements SHALL be durable and SHALL survive the generation's final settle rather than being overwritten by it. The Noise lane's settlement carries what a coverage state used to: it is the durable record of which changed regions no board cited, and it is attempt-scoped like every other lane — a replacement attempt SHALL clear the replaced attempt's lane state durably, so no surface shows one attempt's remainder beside another attempt's boards. After a client reconnect or daemon restart mid-generation, the surface SHALL reconstruct exactly which lanes settled with what, including which lanes the Noise lane is still waiting on. A write from a superseded generation attempt SHALL be rejected AND SHALL NOT be broadcast — a refusal on disk that still reaches connected clients publishes a dead attempt's work under the live generation's label.

#### Scenario: Daemon restarts mid-generation

- **WHEN** the daemon restarts after two lanes settled and before the Noise lane could start
- **THEN** the reconnected surface shows those two settlements and shows the Noise lane waiting on the lanes that have not settled, from durable state, not a reset or an invented completion

#### Scenario: Obsolete attempt writes late

- **WHEN** a lane result arrives from a generation attempt that has been superseded
- **THEN** the write is rejected and the current generation's state is unchanged
