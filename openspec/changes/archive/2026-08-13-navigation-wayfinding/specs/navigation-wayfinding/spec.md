## ADDED Requirements

### Requirement: Navigation is a surface stack with history
The renderer SHALL model location as a stack of surfaces (`projects` → `project` → `review` → `draft` → `paper`). Navigating to a surface SHALL push it (recording history); Back SHALL pop to the prior surface and Forward SHALL re-push, via both on-screen controls and `⌘[` / `⌘]`.

#### Scenario: Back from a review lands on project detail
- **WHEN** the reviewer opens a project, then a review, then activates Back
- **THEN** project detail is shown (the review's parent surface), NOT the front door

#### Scenario: A crumb click ascends
- **WHEN** the reviewer clicks an ancestor breadcrumb segment
- **THEN** the stack truncates to that tier and that surface is shown

### Requirement: Lenses are peers, surfaces are children, transient views are overlays
Switching a review lens (Files, Spec, Sequence, Decisions, Flagged, Noise) SHALL NOT push a surface, move the breadcrumb, or record history. Draft, Paper, and Re-review SHALL be child surfaces that extend the breadcrumb and record history. Conversation/Ask, the symbol inspector, the command palette, and Settings SHALL be overlays that touch neither the breadcrumb nor history and close back to the current surface.

#### Scenario: A lens switch does not navigate
- **WHEN** the reviewer switches from one lens to another
- **THEN** the breadcrumb and the history length are unchanged

#### Scenario: An overlay does not enter history
- **WHEN** the reviewer opens Settings (or the palette, or the symbol inspector) and closes it
- **THEN** the current surface is unchanged and no history entry was added

### Requirement: The command palette carries a Navigate group and no retired lens
The command palette SHALL offer a Navigate group (go to project, open review, back, forward, go to draft/paper within a review, open settings, and recent locations on an empty query). It SHALL NOT offer a command for the retired `claims` lens.

#### Scenario: Navigate commands present, claims absent
- **WHEN** the palette's commands are built in a workspace
- **THEN** a back-navigation command is present and no `claims` lens command exists

### Requirement: No navigation act is gated
Every navigation — back, forward, a breadcrumb ascent, a palette jump, leaving a mid-edit draft — SHALL be a plain move with no confirmation, consent, acknowledgement, or capability denial. A draft's in-progress state SHALL persist across navigating away and back (state preservation, not a prompt).

#### Scenario: Leaving a mid-edit draft does not prompt
- **WHEN** the reviewer navigates away from a draft with unsent edits and returns
- **THEN** no confirmation was shown and the draft's state is preserved
