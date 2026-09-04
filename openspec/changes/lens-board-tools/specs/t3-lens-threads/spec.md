## MODIFIED Requirements

### Requirement: A repair is a follow-up turn on the seat's thread

When a seat's turn ends without its board settled, the repair SHALL run as the next turn on the same thread, carrying only what the whole-board check last said and nothing else. The base drafting prompt SHALL NOT be re-sent, the board SHALL NOT be re-sent, and the repair SHALL resume writing into the board the previous turn left. No output schema SHALL be attached to a board seat's turn, and none SHALL be restated in prompt text — a seat's contract is the tool set it is given, which travels once as the turn's tool list.

#### Scenario: One repair after an unfinished turn

- **WHEN** a Decisions turn ends with two pointers outstanding from its last whole-board check
- **THEN** the Decisions thread gains one more turn whose prompt names those two pointers, the thread's first turn is not repeated, and the board's existing elements are still there

#### Scenario: No schema on a seat turn

- **WHEN** any board seat's turn is started
- **THEN** it carries no structured-output contract, and its prompt contains no schema

#### Scenario: retry budget counts thread turns

- **WHEN** a lane has exhausted its repair budget for the attempt
- **THEN** no further turn starts on that seat's thread and the lane settles under the existing outcome domain

### Requirement: A seat's usage and timing reach the collector

Each turn on a seat's thread SHALL report its token usage, its wall-clock duration and the number of board tool calls it made to the review's metrics collector as one record per turn, labelled by seat and attempt, so the generation's spend, timing and authoring-volume summaries include every T3 turn. A turn path that drops any of the three is a defect.

#### Scenario: a two-turn seat records two turns

- **WHEN** a Design seat drafts and then repairs once
- **THEN** the collector holds two records for `board.lens-draft` on that generation, each with tokens, duration and tool-call count from the thread's turn

#### Scenario: Positive control drops the tool-call count

- **WHEN** a control stops threading the tool-call count on one seat path
- **THEN** the collector assertion fails, naming that path
