## MODIFIED Requirements

### Requirement: Lens switcher over six angles, blast-radius is overlay-only

The workspace SHALL present a lens switcher over the five angles. Four (spec, sequence, decisions, noise) are selectable canvases. Blast-radius SHALL be an amber overlay TOGGLE that paints the active canvas, never a selectable fifth canvas or its own queue. There SHALL be no Claims canvas: the ground it covered belongs to the Decisions lens (Rai's verdict, 2026-08-16, issue #221), and no switcher entry, rotation stop, or canvas queue for `claims` SHALL exist.

#### Scenario: blast-radius is not a canvas

- **WHEN** the lens switcher is rendered
- **THEN** exactly four canvas angles are selectable and blast-radius is a distinct overlay toggle
- **AND** enabling the overlay paints amber onto painted targets of the active canvas without changing the active canvas angle

#### Scenario: the claims canvas is unreachable

- **WHEN** the lens switcher is rendered and the lens is rotated through every stop in both directions
- **THEN** no Claims canvas is offered or landed on, and the rotation cycle covers exactly the four selectable canvases plus the flagged lens

## ADDED Requirements

### Requirement: Raw markdown one keystroke away in the Spec angle

The Spec angle's structured OpenSpec viewer SHALL offer the change's raw markdown one keystroke away: a single keystroke SHALL flip the visible artifact from the structured rendering to its verbatim raw markdown text, and the same keystroke SHALL flip it back. The structured rendering SHALL remain the default on every fresh render. The raw view SHALL show the artifact text as read from disk, not a re-serialization of the parsed model.

#### Scenario: one keystroke shows the raw markdown

- **WHEN** the Spec angle renders an OpenSpec change's structured view and the user presses the raw-view keystroke
- **THEN** the visible artifact's verbatim raw markdown replaces the structured rendering

#### Scenario: the same keystroke returns to the structured view

- **WHEN** the raw markdown view is showing and the user presses the raw-view keystroke again
- **THEN** the structured rendering returns, unchanged
