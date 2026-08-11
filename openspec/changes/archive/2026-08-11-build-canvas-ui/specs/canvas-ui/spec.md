# canvas-ui

The rendered canvas surface: the five canvases plus the blast-radius overlay on screen, consuming the #10 canvas state model, making the four product principles legible.

## ADDED Requirements

### Requirement: Lens switcher over six angles, blast-radius is overlay-only

The workspace SHALL present a lens switcher over the six angles. Five (spec, sequence, decisions, claims, noise) are selectable canvases. Blast-radius SHALL be an amber overlay TOGGLE that paints the active canvas, never a selectable sixth canvas or its own queue.

#### Scenario: blast-radius is not a canvas

- **WHEN** the lens switcher is rendered
- **THEN** exactly five canvas angles are selectable and blast-radius is a distinct overlay toggle
- **AND** enabling the overlay paints amber onto painted targets of the active canvas without changing the active canvas angle

### Requirement: Aggressive roll-up, collapse is not read

The decisions canvas SHALL render cohorts collapsed by default with honest counts, uncapped and untruncated. Expand/collapse SHALL be navigation only and SHALL NOT change read state; coverage SHALL report collapsed content as unread.

#### Scenario: a fully-collapsed cohort still reports unread

- **WHEN** every cohort is collapsed and no disposition covers its anchors
- **THEN** coverage reports those anchors as unread

#### Scenario: 100+ decisions render with zero truncation

- **WHEN** a canvas carries 100+ decisions across cohorts
- **THEN** every decision is reachable and none is truncated, with usable roll-up

### Requirement: Approve at any granularity, one user act fans out

The user SHALL be able to apply a disposition (approve / request-change / comment / question) at whole-roll-up, cohort, partial selection, or single anchor. A group act SHALL be ONE user act that fans out to per-anchor L2 dispositions.

#### Scenario: cohort approve creates per-anchor L2 in one act

- **WHEN** the user approves a cohort of N anchors
- **THEN** exactly N per-anchor disposition writes are produced from one user act, one per anchor

### Requirement: Zoom in and out at any point, keyboard-first

The surface SHALL support zooming roll-up → cohort → element → diff and back, keyboard-first.

#### Scenario: zoom traverses both directions

- **WHEN** the user zooms in from roll-up to the diff and back out
- **THEN** each level (roll-up, cohort, element, diff) is reachable in both directions

### Requirement: L3 rendering is the agent's hand, only acceptance creates L2

Orchestrator annotations SHALL render visually distinct as chrome (glass doctrine), never looking like L1 analysis or L2 human judgment. Proposals SHALL render next to their target with accept / edit / dismiss; edit-then-accept is first-class; only acceptance SHALL create L2.

#### Scenario: dismiss creates no L2

- **WHEN** the user dismisses an orchestrator disposition proposal
- **THEN** no disposition is created

#### Scenario: edit-then-accept creates L2 with the edited body

- **WHEN** the user edits a proposal's body and accepts it
- **THEN** a disposition is created carrying the edited body

### Requirement: Diff via a windowed CodeView (R16)

The diff SHALL render through a windowed `CodeView` whose rendered DOM node count stays within a bounded envelope regardless of diff length; the naive full render SHALL exceed the envelope.

#### Scenario: a 5k-line diff holds the node-count envelope

- **WHEN** a 5000-line diff is rendered through the windowed CodeView
- **THEN** the rendered node count stays within the envelope while a full render of the same fixture exceeds it

### Requirement: Glass tokens, no hardcoded hex

The glass token system SHALL be the only place raw hex lives; both the dark default and the bright-room light scheme SHALL render. A hardcoded hex anywhere else in the UI package SHALL fail lint.

#### Scenario: a hardcoded hex fails lint

- **WHEN** a UI component carries a hardcoded hex literal
- **THEN** lint fails; a component using `var(--token)` passes

### Requirement: Fixed-point lens rotation

Rotating the lens SHALL keep the hunk under the cursor fixed.

#### Scenario: the cursor hunk survives rotation

- **WHEN** the active lens rotates while a cursor anchor is set
- **THEN** the cursor anchor is preserved and re-centered on the new canvas

### Requirement: R35 subscription lifecycle, no RxJS

Live updates SHALL arrive as change-feed notifications bound through `useSyncExternalStore`; every subscription SHALL have a stated owner and disposal point (unmount / review close). Ephemeral view state SHALL be `zustand`. No RxJS.

#### Scenario: a subscription is disposed on teardown

- **WHEN** a canvas subscription's teardown runs
- **THEN** the source no longer holds the listener (no leak)
