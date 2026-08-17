# canvas-ui Specification

## Purpose
TBD - created by archiving change build-canvas-ui. Update Purpose after archive.
## Requirements
### Requirement: Lens switcher over six angles, blast-radius is overlay-only

The workspace SHALL present a lens switcher over the five angles. Four (spec, sequence, decisions, noise) are selectable canvases. Blast-radius SHALL be an amber overlay TOGGLE that paints the active canvas, never a selectable fifth canvas or its own queue. There SHALL be no Claims canvas: the ground it covered belongs to the Decisions lens (Rai's verdict, 2026-08-16, issue #221), and no switcher entry, rotation stop, or canvas queue for `claims` SHALL exist.

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

### Requirement: The Flagged empty state discloses blocked ingestion

The Flagged lens SHALL receive the review's incomplete-ingestion blocking states (R18: truncated, binary, submodule) alongside the flagged result, and SHALL render a disclosure of them whenever the set is non-empty — each entry naming its reason and its human-facing detail. When blocking states are non-empty, the unqualified all-clear copy ("ran clean") SHALL be unreachable: a review that flagged nothing over partially-ingested content SHALL state that nothing was flagged in what could be read AND that some content was not ingested. The disclosure is honest copy only — it SHALL NOT add any confirmation, acknowledgement, or gate to the lens.

#### Scenario: An empty result over blocked ingestion is qualified, never "ran clean"

- **WHEN** the Flagged lens renders a review that flagged nothing and whose blocking states carry a truncated or binary entry
- **THEN** the lens does not display the unqualified "ran clean" all-clear, and instead displays the qualified empty state plus the blocked-ingestion disclosure with each entry's reason and detail

#### Scenario: A fully-ingested empty result keeps the honest all-clear

- **WHEN** the Flagged lens renders a review that flagged nothing and whose blocking states are empty
- **THEN** the existing honest all-clear renders unchanged ("ran clean, not skipped"), with no disclosure block

#### Scenario: Blocked ingestion is disclosed even beside findings

- **WHEN** the Flagged lens renders a review with one or more findings and non-empty blocking states
- **THEN** the blocked-ingestion disclosure renders beside the findings, because an absence of findings over un-ingested content is not evidence it was reviewed

#### Scenario: Blocked ingestion is disclosed when automated review fails

- **WHEN** the Flagged lens renders a failed automated review with non-empty deterministic blocking states
- **THEN** the existing "Couldn't check" state remains visible and the blocked-ingestion disclosure renders beside it
- **AND WHEN** the failed review has no blocking states
- **THEN** the failed state renders exactly as it did before the disclosure change

### Requirement: Raw markdown one keystroke away in the Spec angle

The Spec angle's structured OpenSpec viewer SHALL offer the change's raw markdown one keystroke away: a single keystroke SHALL flip the visible artifact from the structured rendering to its verbatim raw markdown text, and the same keystroke SHALL flip it back. The structured rendering SHALL remain the default on every fresh render. The raw view SHALL show the artifact text as read from disk, not a re-serialization of the parsed model.

#### Scenario: one keystroke shows the raw markdown

- **WHEN** the Spec angle renders an OpenSpec change's structured view and the user presses the raw-view keystroke
- **THEN** the visible artifact's verbatim raw markdown replaces the structured rendering

#### Scenario: the same keystroke returns to the structured view

- **WHEN** the raw markdown view is showing and the user presses the raw-view keystroke again
- **THEN** the structured rendering returns, unchanged

### Requirement: ConversationMargin aligns against a supplied rendered diff

When `ConversationMargin` receives a diff ref and a conversation thread's anchor row is rendered beneath that ref, the component SHALL vertically position each thread panel using `rowTop - panelNaturalTop`, keyed through the panel's existing `data-anchor-key`. When the diff ref or anchor row is absent, the component SHALL fall back to stacked document order — never a fabricated position and never hidden. The component SHALL only transform panels in its rail and SHALL NOT write to or reflow the supplied diff. App-level threading of the diff ref is outside this delta.

#### Scenario: supplied non-zero multi-panel geometry aligns each panel

- **WHEN** `ConversationMargin` receives a diff ref containing rendered rows for two panels with different natural top positions
- **THEN** each panel carries its own `rowTop - panelNaturalTop` offset rather than the row's absolute offset from the rail

#### Scenario: an absent anchor row falls back honestly

- **WHEN** the supplied diff ref does not contain a thread's anchor row, or no diff ref is supplied
- **THEN** the thread panel renders in stacked document order in the rail, still reachable and readable, with no synthetic offset

#### Scenario: the component never reflows the supplied diff

- **WHEN** `ConversationMargin` aligns, adds, or removes thread panels beside the supplied diff
- **THEN** the diff column's width and row positions are unaffected

