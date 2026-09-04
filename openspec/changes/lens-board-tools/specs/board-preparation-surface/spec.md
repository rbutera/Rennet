## MODIFIED Requirements

### Requirement: The workspace opens immediately with capture as its first lane

Starting a review SHALL open the review's workspace at once, ON ITS BOARDS. Capture SHALL be reported in the workspace's own header, naming the step it is on (resolving the repository, capturing the change) and offering cancel, while the board view is already on screen. Capture SHALL NOT be a separate screen, and there SHALL NOT be a waiting stage of any kind between the reviewer and the boards.

#### Scenario: a branch review opens

- **WHEN** the reviewer starts a review of a branch
- **THEN** the board view is on screen before capture completes, with the capture step named in the workspace header and every lens listed in the rail

### Requirement: Each lens shows its latest event live while it runs

For every running seat, the surface SHALL show the seat's most recent event from its thread, updated as the thread streams: the tool call in progress named in plain words (the file being read, the command being run, the element it just wrote, the citation it just made), or the last sentence of the agent's own text when no tool call is in flight. A tool call's raw input SHALL NEVER be rendered as the seat's speech. The line SHALL be carried by that seat's entry in the lens rail and, for the selected lens, by the widget above its board, and SHALL make the difference between a working seat, a settled seat, and a failed seat visible at a glance.

#### Scenario: a seat reads a file

- **WHEN** the Sequence seat's thread begins a tool call that reads `src/foo.ts`
- **THEN** within a second the Sequence entry shows that it is reading `src/foo.ts`

#### Scenario: a seat writes an element

- **WHEN** the Sequence seat adds its third step
- **THEN** the line says so in plain words, and contains no JSON

#### Scenario: a seat is between tool calls

- **WHEN** the Design seat's thread streams assistant text with no tool call in flight
- **THEN** the Design entry shows the latest sentence of that text, truncated with an honest marker if long

#### Scenario: a seat fails

- **WHEN** a seat's thread turn settles as failed
- **THEN** the failure reason from the thread is shown against that seat and the lane is marked failed, not left spinning

### Requirement: A lens opens its full transcript read-only

Activating a seat SHALL open that seat's complete thread transcript in a surface of the board region's own — never the chat slot: tool calls, thinking, streamed text and per-turn diffs, with no composer. The transcript SHALL keep streaming while the seat runs and SHALL remain readable after the seat settles. The chat slot SHALL continue to show the session's own thread the whole time.

#### Scenario: open a running lens

- **WHEN** the reviewer activates the Decisions seat while its seat runs
- **THEN** the Decisions thread streams in its own surface without a composer, and the chat slot still holds the session's thread

#### Scenario: open a settled lens later

- **WHEN** the reviewer opens the Flagged transcript after the lane has settled
- **THEN** the full transcript of both Flagged seats is readable, each reachable from its own voice

## REMOVED Requirements

### Requirement: Boards replace their presence as they settle

**Reason**: There is no presence for a board to replace. A board now exists from the moment its seat thread is created and is on screen being written; settling changes its state in place rather than substituting one thing for another, and the seat's transcript is reachable from the widget above the board, not from a presence the board replaced.

**Migration**: The behaviour this protected — a settled lane readable without waiting for the others — is carried by `live-board-workspace`'s "A board renders as it is written and says it is provisional" and "One widget above the board names the seat doing the work", which are stronger: the board is readable before its lane settles, not merely as soon as it does.
