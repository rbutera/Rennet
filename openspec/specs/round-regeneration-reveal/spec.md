# Round regeneration reveal specification

## Purpose

Define latency, reveal, timing-honesty, and durability behavior for board generation — both the initial generation and every post-round regeneration share the same pipeline and the same barrier defect: completed core boards must appear as they settle, phase labels must tell the truth, retry budgets stay proportional, and reveal state survives restarts.

## Requirements

### Requirement: Core boards reveal progressively as each lane settles

In every generation — initial and post-round — the Sequence, Decisions, and Flagged lanes SHALL start as soon as their inputs are ready (for a post-round regeneration, the verified round report; for the initial generation, the captured patchset), and each semantically accepted board or typed absence SHALL become visible when that lane settles. A slow or failing Design or Noise lane SHALL NOT keep a completed core result invisible, and no global barrier over all lanes SHALL gate the reveal of settled core boards.

#### Scenario: Design lane is slow while core lanes settle

- **WHEN** Sequence, Decisions, and Flagged settle while the Design lane is still running
- **THEN** the three settled results are visible to the reviewer before the Design lane ends

#### Scenario: Initial generation reveals progressively too

- **WHEN** a fresh review's first generation runs and two core lanes settle early
- **THEN** those boards are visible before the remaining lanes or coverage complete

#### Scenario: Positive control holds core boards behind a barrier

- **WHEN** a control reintroduces a global all-lanes barrier before reveal
- **THEN** the reveal-timing assertion fails

### Requirement: Cross-lens coverage is honest without becoming a reveal barrier

When cross-lens coverage is still pending while core boards are visible, the surface SHALL say coverage is pending explicitly. Coverage completion SHALL update the surface's coverage state; withholding settled boards is not an acceptable way to represent pending coverage.

#### Scenario: Coverage pending after core reveal

- **WHEN** core boards are revealed and cross-lens coverage has not completed
- **THEN** the surface states that coverage is pending rather than hiding the boards or claiming coverage

### Requirement: Reveal state is durable and reconstructable

Per-lane settlements and a generation-keyed coverage state (`pending` / `complete` / `failed`) SHALL be durable, and SHALL survive the generation's final settle rather than being overwritten by it. Coverage is attempt-scoped: a replacement attempt SHALL clear the replaced attempt's coverage durably and publish `pending` on its first frame, so no surface shows a completed coverage beside lanes queued for a redraft. After a client reconnect or daemon restart mid-generation, the surface SHALL reconstruct exactly which lanes settled with what and what coverage state holds. A write from a superseded generation attempt SHALL be rejected AND SHALL NOT be broadcast — a refusal on disk that still reaches connected clients publishes a dead attempt's work under the live generation's label.

#### Scenario: Daemon restarts mid-generation

- **WHEN** the daemon restarts after two lanes settled and before coverage completed
- **THEN** the reconnected surface shows those two settlements and pending coverage from durable state, not a reset or an invented completion

#### Scenario: Obsolete attempt writes late

- **WHEN** a lane result arrives from a generation attempt that has been superseded
- **THEN** the write is rejected and the current generation's state is unchanged

### Requirement: Generation phases carry distinct durable timings

The system SHALL record distinct durable timings for the round report, each lens lane's draft, repair, and post-process steps, coverage, and reveal — including time-to-first-core-board per generation. A lane that runs more than one seat SHALL record one draft timing PER SEAT, each naming the harness and model that executed it, so the lane's aggregate span stays derivable while no stage record is left unattributable. Time-to-first-core-board SHALL be measured from the moment the reviewer's wait began — the captured input on an initial generation, the landed round and verified report on a returned one — not from the drafting runtime's own entry. The `reveal` timing SHALL end at the last lane that actually revealed a result. The visible phase label SHALL name the phase actually running; lens work SHALL NOT be labeled as report drafting.

#### Scenario: Reviewer inspects a finished regeneration

- **WHEN** a post-round regeneration completes
- **THEN** durable per-phase timings exist for report, each lens lane, coverage, reveal, and time-to-first-core-board, and no single label absorbed another phase's time

#### Scenario: The dual Flagged lane records both seats

- **WHEN** the Flagged lane runs two harnesses
- **THEN** two draft timings are recorded for that lane, each naming its own harness and model, and the run's dual-model mode is derivable from those records alone

#### Scenario: Positive control mislabels lens work

- **WHEN** a control routes lens-lane time under the report-drafting label
- **THEN** the timing assertion fails

### Requirement: Retry budgets are proportional per lane and attempt

Each lens lane's retry/editor budget SHALL be bounded per lane and per attempt by an explicit table. A repeated whole-board attempt SHALL draw the table's repeat entry rather than a silently refreshed full validation-retry ladder. The repeat entry SHALL never exceed the first attempt's, so N restarts cost N bounded attempts; and it SHALL never be zero, because a zero budget ends a lane on one malformed output and the restart recovery exists precisely to re-draft such a lane.

#### Scenario: Second whole-board attempt on one lane

- **WHEN** a lane's first board attempt fails and a second whole-board attempt starts
- **THEN** the second attempt runs under the table's bounded repeat budget, no richer than the first attempt's

#### Scenario: A repeat attempt hits one malformed output

- **WHEN** a restart's redraft receives an unparseable board on its first turn
- **THEN** the lane still has a repair turn and can produce a board, rather than terminating permanently

### Requirement: The owner journey is proven on a tiny real round

A guarded launched-desktop run on a small real change SHALL publish per-phase timings including time-to-first-core-board, peak descendant resource figures, and zero-survivor cleanup evidence for the full post-round regeneration, measured against the working latency targets stated in the design.

#### Scenario: Tiny-round proof runs

- **WHEN** the guarded owner journey executes a one-line real change through a coding round and regeneration
- **THEN** the published evidence includes per-phase durations, time-to-first-core-board, peak descendant RSS and process counts, and a zero-survivor cleanup result
