# board-preparation-surface Specification

## Purpose
The screen a reviewer waits on while boards are drafted shows each lens as a living presence with what it is doing right now, opens any lens's full transcript on demand, and never hides the workspace behind a separate capture page.
## Requirements
### Requirement: The workspace opens immediately with capture as its first lane

Starting a review SHALL open the review's workspace at once. Capture SHALL appear as the first stage inside that workspace, alongside the lens stages, and SHALL NOT be a separate screen. While capture runs, the surface SHALL name the step it is on (resolving the repository, capturing the change) and SHALL offer cancel.

#### Scenario: a branch review opens
- **WHEN** the reviewer starts a review of a branch
- **THEN** the workspace is on screen before capture completes, with capture shown as the first stage and the lens stages queued behind it

### Requirement: Each lens shows its latest event live while it runs

For every running seat, the surface SHALL show the seat's most recent event from its thread, updated as the thread streams: the tool call in progress named in plain words (for example the file being read or the command being run), or the last sentence of the agent's own text when no tool call is in flight. The presentation SHALL be an evocative one (each lens as a distinct presence at work on the change) rather than a status table, and SHALL make the difference between a working seat, a settled seat, and a failed seat visible at a glance.

#### Scenario: a seat reads a file
- **WHEN** the Sequence seat's thread begins a tool call that reads `src/foo.ts`
- **THEN** within a second the Sequence presence shows that it is reading `src/foo.ts`

#### Scenario: a seat is between tool calls
- **WHEN** the Design seat's thread streams assistant text with no tool call in flight
- **THEN** the Design presence shows the latest sentence of that text, truncated with an honest marker if long

#### Scenario: a seat fails
- **WHEN** a seat's thread turn settles as failed
- **THEN** the presence shows the failure reason from the thread and the lane is marked failed, not left spinning

### Requirement: A lens opens its full transcript read-only

Activating a lens presence SHALL open that seat's complete thread transcript in the chat slot as a read-only thread view: tool calls, thinking, streamed text and per-turn diffs, with no composer. The transcript SHALL keep streaming while the seat runs and SHALL remain readable after the seat settles and after the boards reveal.

#### Scenario: open a running lens
- **WHEN** the reviewer activates the Decisions presence while its seat runs
- **THEN** the chat slot shows the Decisions thread streaming, without a composer

#### Scenario: open a settled lens later
- **WHEN** the reviewer opens the Flagged transcript after the boards have revealed
- **THEN** the full transcript of both Flagged seats is readable in the chat slot

### Requirement: Boards replace their presence as they settle

When a lens settles with a board, the surface SHALL reveal that board in place, without waiting for the other lenses, and the presence SHALL remain reachable as the way back to that lens's transcript.

#### Scenario: Flagged settles first
- **WHEN** the Flagged lens settles while three others still run
- **THEN** the Flagged board is readable while the other presences keep showing their latest events

