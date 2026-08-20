# canvas-ui Specification

## Purpose
Defines canvas navigation, disposition authoring, diff rendering, shared visual tokens, and anchored conversation layout in the review workspace.
## Requirements
### Requirement: The lens switcher has four canvases and one overlay

The workspace SHALL present four selectable canvases: spec, sequence, decisions, and noise. Blast radius SHALL be an amber overlay toggle that paints the active canvas, never a selectable canvas or its own queue. The Decisions lens owns decision claims, so no switcher entry, rotation stop, or canvas queue for `claims` SHALL exist.

#### Scenario: blast-radius is not a canvas

- **WHEN** the lens switcher is rendered
- **THEN** exactly four canvas angles are selectable and blast-radius is a distinct overlay toggle
- **AND** enabling the overlay paints amber onto painted targets of the active canvas without changing the active canvas angle

#### Scenario: the claims canvas is unreachable

- **WHEN** the lens switcher is rendered and the lens is rotated through every stop in both directions
- **THEN** no Claims canvas is offered or landed on, and the rotation cycle covers exactly the four selectable canvases plus the flagged lens

### Requirement: Aggressive roll-up, collapse is not read

The decisions canvas SHALL render cohorts collapsed by default with honest counts, uncapped and untruncated. Expand/collapse SHALL be navigation only and SHALL NOT change read state; coverage SHALL report collapsed content as unread.

#### Scenario: a fully-collapsed cohort still reports unread

- **WHEN** every cohort is collapsed and no disposition covers its anchors
- **THEN** coverage reports those anchors as unread

#### Scenario: 100+ decisions render with zero truncation

- **WHEN** a canvas carries 100+ decisions across cohorts
- **THEN** every decision is reachable and none is truncated, with usable roll-up

### Requirement: Approve at any granularity, one user act fans out

The user SHALL be able to approve, request a change, comment, or ask a question at whole-roll-up, cohort, partial-selection, or single-anchor granularity. A group action SHALL remain one user action that creates per-anchor L2 dispositions.

#### Scenario: cohort approve creates per-anchor L2 in one act

- **WHEN** the user approves a cohort of N anchors
- **THEN** exactly N per-anchor disposition writes are produced from one user act, one per anchor

### Requirement: Zoom in and out at any point, keyboard-first

The workspace SHALL support keyboard-first zoom through roll-up, cohort, element, and diff levels in both directions.

#### Scenario: zoom traverses both directions

- **WHEN** the user zooms in from roll-up to the diff and back out
- **THEN** each level (roll-up, cohort, element, diff) is reachable in both directions

### Requirement: L3 proposals are distinct and only acceptance creates L2

Orchestrator annotations SHALL render as interface chrome that is visually distinct from L1 analysis and L2 human judgment. Proposals SHALL render beside their target with accept, edit, and dismiss actions. Only acceptance SHALL create L2.

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

### Requirement: Shared theme tokens supply every product color

The shared Affineur's Bench theme SHALL be the only source of raw color values for product interfaces. Dark and light schemes SHALL both render, and UI components SHALL use shared tokens rather than hardcoded colors. The UI SHALL NOT use glass, translucency, vibrancy, or the review-blue accent.

#### Scenario: A hardcoded color fails lint

- **WHEN** a UI component contains a raw hex color
- **THEN** lint fails while a component using a shared theme token passes

#### Scenario: A forbidden glass style is introduced

- **WHEN** a product interface adds translucent glass, vibrancy, or the review-blue accent
- **THEN** the design checks fail

### Requirement: Fixed-point lens rotation

Rotating the lens SHALL keep the hunk under the cursor fixed.

#### Scenario: the cursor hunk survives rotation

- **WHEN** the active lens rotates while a cursor anchor is set
- **THEN** the cursor anchor is preserved and re-centered on the new canvas

### Requirement: R35 subscription lifecycle, no RxJS

Live updates SHALL arrive as change-feed notifications bound through `useSyncExternalStore`. Every subscription SHALL name its owner and disposal point, either component unmount or review close. `zustand` SHALL hold ephemeral view state. The UI SHALL NOT use RxJS.

#### Scenario: a subscription is disposed on teardown

- **WHEN** a canvas subscription's teardown runs
- **THEN** the source no longer holds the listener (no leak)

### Requirement: The Flagged empty state discloses blocked ingestion

The Flagged lens SHALL receive the review's incomplete-ingestion states alongside the flagged result. The states cover truncated files, binaries, and submodules. When the set is non-empty, the lens SHALL render each entry's reason and human-readable detail. It SHALL NOT show the unqualified "ran clean" copy. If review found nothing in readable content, the copy SHALL also state that some content was not ingested. This disclosure SHALL add no confirmation, acknowledgement, or gate.

#### Scenario: An empty result over blocked ingestion is qualified, never "ran clean"

- **WHEN** the Flagged lens renders a review that flagged nothing and whose blocking states carry a truncated or binary entry
- **THEN** the lens does not display the unqualified "ran clean" all-clear, and instead displays the qualified empty state plus the blocked-ingestion disclosure with each entry's reason and detail

#### Scenario: A fully-ingested empty result keeps the honest all-clear

- **WHEN** the Flagged lens renders a review that flagged nothing and whose blocking states are empty
- **THEN** the honest all-clear reads "ran clean, not skipped" and no disclosure block renders

#### Scenario: Blocked ingestion is disclosed even beside findings

- **WHEN** the Flagged lens renders a review with one or more findings and non-empty blocking states
- **THEN** the blocked-ingestion disclosure renders beside the findings, because an absence of findings over un-ingested content is not evidence it was reviewed

#### Scenario: Blocked ingestion is disclosed when automated review fails

- **WHEN** the Flagged lens renders a failed automated review with non-empty deterministic blocking states
- **THEN** the "Couldn't check" state remains visible and the blocked-ingestion disclosure renders beside it
- **AND WHEN** the failed review has no blocking states
- **THEN** the failed state renders without a blocked-ingestion disclosure

### Requirement: Raw markdown one keystroke away in the Spec angle

The Spec angle's structured OpenSpec viewer SHALL offer the change's raw markdown one keystroke away: a single keystroke SHALL flip the visible artifact from the structured rendering to its verbatim raw markdown text, and the same keystroke SHALL flip it back. The structured rendering SHALL remain the default on every fresh render. The raw view SHALL show the artifact text as read from disk, not a re-serialization of the parsed model.

#### Scenario: one keystroke shows the raw markdown

- **WHEN** the Spec angle renders an OpenSpec change's structured view and the user presses the raw-view keystroke
- **THEN** the visible artifact's verbatim raw markdown replaces the structured rendering

#### Scenario: the same keystroke returns to the structured view

- **WHEN** the raw markdown view is showing and the user presses the raw-view keystroke again
- **THEN** the structured rendering returns, unchanged

### Requirement: ConversationMargin aligns against a supplied rendered diff

When `ConversationMargin` receives a diff ref and renders a conversation thread's anchor row under it, the component SHALL position each thread panel with `rowTop - panelNaturalTop`. It SHALL key the panel through its `data-anchor-key`. If the diff ref or anchor row is absent, the component SHALL stack panels in document order without fabricating a position or hiding the thread. The component SHALL transform only panels in its rail and SHALL NOT reflow the supplied diff. The review workspace SHALL pass a live diff ref through the conversation column into `ConversationMargin`.

#### Scenario: supplied non-zero multi-panel geometry aligns each panel

- **WHEN** `ConversationMargin` receives a diff ref containing rendered rows for two panels with different natural top positions
- **THEN** each panel carries its own `rowTop - panelNaturalTop` offset rather than the row's absolute offset from the rail

#### Scenario: an absent anchor row falls back honestly

- **WHEN** the supplied diff ref does not contain a thread's anchor row, or no diff ref is supplied
- **THEN** the thread panel renders in stacked document order in the rail, still reachable and readable, with no synthetic offset

#### Scenario: the component never reflows the supplied diff

- **WHEN** `ConversationMargin` aligns, adds, or removes thread panels beside the supplied diff
- **THEN** the diff column's width and row positions are unaffected

#### Scenario: the review heart supplies the diff ref end to end

- **WHEN** the review heart renders its diff surface beside the conversation column with at least one anchored thread whose anchor row is on-window
- **THEN** the thread's panel is aligned against that row through the threaded diff ref, without any change to the diff column's layout

### Requirement: Rendered diff rows carry queryable anchor identity

The rendered diff SHALL stamp each content row with the line's anchor key, and the chunk container SHALL carry its chunk anchor key. `ConversationMargin` SHALL locate an anchored thread's row by that key within the supplied diff ref. A key that matches no rendered row SHALL resolve to no element. This includes range anchors and rows outside the render window. The thread SHALL then use the stacked fallback without a fabricated position.

#### Scenario: a line-anchored thread's row is discoverable

- **WHEN** the diff surface renders a row for a line that an open conversation thread is anchored to
- **THEN** querying the diff ref by that thread's anchor key locates exactly that row

#### Scenario: an off-window or unmatched anchor resolves to nothing

- **WHEN** a thread's anchor row is outside the current render window, or the anchor's key grammar does not identify a single rendered row
- **THEN** the anchor-key query finds no element and the thread panel renders stacked, reachable, and unhidden

### Requirement: The review heart's conversation column renders the aligned margin path

The review workspace SHALL render one conversation panel per thread. Each panel SHALL carry its anchor key, align when its anchor row is rendered, and stack otherwise. Asking, promotion, and sub-thread actions SHALL remain available. The conversation column SHALL NOT reflow the diff. Alignment SHALL remeasure after scrolling, resizing, or a diff-size change. It SHALL NOT gate, confirm, or block a review action.

#### Scenario: scrolling the windowed diff re-aligns without reflow

- **WHEN** the user scrolls the diff so a thread's anchor row enters or leaves the render window
- **THEN** the thread's panel gains or loses its alignment offset accordingly, and the diff column's row positions are unaffected

#### Scenario: Conversation actions remain available

- **WHEN** the review heart renders the aligned margin path
- **THEN** a thread panel offers ask, promote, and sub-thread actions
