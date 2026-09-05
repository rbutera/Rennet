## Purpose

A review opens on its boards. Every lens is there from the first frame, the selected board draws itself while the reviewer watches, one widget above it names the seat doing the work, and that seat's transcript opens in its own surface — never over the reviewer's own conversation.

## ADDED Requirements

### Requirement: A review opens on the board view, with no waiting screen in front of it

Starting or opening a review SHALL land the reviewer on the board view. There SHALL NOT be a separate preparation stage that the boards later replace. Capture SHALL be reported in the workspace's own header, naming the step it is on, while the board view is already on screen behind it.

#### Scenario: A branch review opens

- **WHEN** the reviewer starts a review of a branch
- **THEN** the board view is on screen before capture completes, with the capture step named in the workspace header

#### Scenario: Nothing navigates when a lane settles

- **WHEN** the selected lens settles
- **THEN** the reviewer stays on the same view at the same route, and the board they were watching becomes the finished board

### Requirement: Every lens is listed and selectable from the first frame

The lens rail SHALL list all five lenses for the generation from the moment the generation starts, whether or not a lens has a result. Each SHALL carry the state of its seat — waiting, working, settled, failed, or absent — and a lens whose seat is still running SHALL be selectable. A lens SHALL NOT be omitted from the rail because it has no terminal result, and SHALL NOT be shown as a disabled control.

A lens whose input is another lane's settlement — Noise, whose board is the complement of the other four — SHALL read as WAITING until those lanes settle, naming what it is waiting for. It SHALL NOT read as working, because no seat is running and no elements are coming, and it SHALL NOT read as stalled or failed.

The Flagged lens SHALL carry one indicator per voice, because it runs two seats.

#### Scenario: A running lens is selectable

- **WHEN** two lenses have settled and three are still running
- **THEN** all five are in the rail, the three running ones show they are working, and selecting one of them shows its board being written

#### Scenario: Noise reads as waiting, not working

- **WHEN** two lanes have settled and two are still running
- **THEN** the Noise entry says it is waiting on the lanes that have not settled, shows no working indicator, and is not shown as failed

#### Scenario: Flagged shows two voices

- **WHEN** the Flagged lane runs a Claude seat and a Codex seat
- **THEN** its rail entry carries an indicator for each voice

### Requirement: A board renders as it is written and says it is provisional

The selected board SHALL render each element as the seat writes it, without waiting for the lane to settle. While the board is unsettled it SHALL say so in three independent ways: the lens's rail entry shows its seat working, the board's own header carries an in-progress mark and states that the board is still being written, and the last row of the board is a placeholder saying the next element lands there.

When the lane settles, all three SHALL clear together. The round-delta marks that distinguish a regenerated board's elements SHALL be withheld while the board is unsettled and SHALL appear when it settles, because a partial board would mark every element as new.

#### Scenario: An element lands

- **WHEN** the seat adds a step to the selected board
- **THEN** that step appears on the board without the lane having settled, and the in-progress mark, the rail indicator and the placeholder row are all still shown

#### Scenario: The board settles

- **WHEN** the lane settles
- **THEN** the in-progress mark, the rail indicator and the placeholder row clear together, and the delta marks appear

#### Scenario: Positive control removes one signal

- **WHEN** a control removes the board header's in-progress mark
- **THEN** the assertion that an unsettled board is marked in three independent ways fails

### Requirement: One widget above the board names the seat doing the work

Above the selected board the surface SHALL show the seat that is writing it: its lens, its provider and model, how long it has been running, its latest event in plain words, and what it has produced so far. A lane with two voices SHALL show both, each with its own provider, model, state and control. A failed seat SHALL show its failure in place, with the retry for that lens offered there.

When the lane settles the widget SHALL collapse to a one-line receipt — who drafted it, how long it took, what it produced — which remains the way back into that seat's transcript.

#### Scenario: A working seat

- **WHEN** the Sequence seat is reading a file
- **THEN** the widget names the Sequence seat, its provider and model, its elapsed time, what it is reading, and how many elements it has written

#### Scenario: A settled seat

- **WHEN** the Sequence lane settles
- **THEN** the widget is a single receipt line naming the seat, the duration and what the board holds, and it still opens the transcript

#### Scenario: One voice of two fails

- **WHEN** the Codex voice of the Flagged lane fails while the Claude voice runs
- **THEN** the failure is shown against that voice with its reason, the other voice keeps reporting, and the retry offered is for that lens

### Requirement: A seat transcript opens in its own surface and never displaces the reviewer's conversation

Activating a seat's widget SHALL open that seat's full thread transcript, live and read-only, in a surface of its own within the board region. The chat dock SHALL continue to show the session's own thread throughout, in every state of every lane. No control SHALL point the chat dock at a seat's thread.

The transcript surface and the diff view SHALL share one slot: opening either SHALL close the other, and the control SHALL say which is open. Below the shell's minimum surface width the transcript SHALL take the whole board region, and SHALL still not displace the chat dock.

Selecting a different lens SHALL move the board, the widget and the transcript together, so the three cannot describe different lenses.

#### Scenario: The dock keeps the conversation

- **WHEN** the reviewer opens the Decisions seat's transcript while its seat runs
- **THEN** the transcript streams in its own surface and the chat dock still shows the session's thread

#### Scenario: Switching lens moves all three

- **WHEN** the reviewer selects another lens while a transcript is open
- **THEN** the board, the widget and the transcript are all that lens's

#### Scenario: The transcript and the diff do not overlap

- **WHEN** the reviewer opens the diff view while a transcript is open
- **THEN** the transcript closes, the diff opens in its place, and the control names what is showing

### Requirement: The board region scrolls

The board region SHALL scroll vertically when its content is taller than the viewport. A board, a widget or a settled lane's content SHALL NOT be truncated, centred out of reach, or clipped where no scroll can reach it.

#### Scenario: A long board on a large change

- **WHEN** a settled board on a ninety-five file change is taller than the pane
- **THEN** every element of it is reachable by scrolling, including the widget above it
