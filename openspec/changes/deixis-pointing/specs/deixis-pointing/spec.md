# deixis-pointing

Two-way pointing between the agent and the reviewer over the inhabited CodeView: the agent's `canvas.focus` resolves to a real, transient viewport action, and the reviewer's span selection rides the next ask into the orchestrator's context at span granularity. Deixis points; it never gates, never mutates read-state or L2, never blocks.

## ADDED Requirements

### Requirement: canvas.focus resolves to a scroll and a transient pulse

When the orchestrator calls `canvas.focus(target)` during a live ask turn, the open review's CodeView SHALL scroll the anchor's resolved span into view and pulse it briefly (a finite CSS animation). The signal SHALL cross main→renderer as a schema-declared `ask-focus` event on the ask-stream channel keyed by `reviewId`.

#### Scenario: the agent's finger lands

- **WHEN** a live turn's `canvas.focus` emits a focus effect for an anchor that resolves in the open CodeView
- **THEN** the renderer receives exactly one schema-valid `ask-focus` event carrying the op's target verbatim
- **AND** the CodeView scrolls the resolved span into view and its rows pulse
- **AND** no confirmation, consent step, or dialog is interposed

#### Scenario: repeat pointing re-pulses

- **WHEN** the agent focuses the same anchor a second time
- **THEN** the span pulses again (the event is not swallowed by unchanged state)

### Requirement: focus is presentational only

A focus delivery SHALL mutate no read-state, no L2 disposition, no view-store selection, and no persisted state. Read-state SHALL remain a fold over user actions only: spans an agent jump scrolls past emit no scrolled/skimmed event.

#### Scenario: nothing becomes read

- **WHEN** a focus effect scrolls the CodeView past intervening spans to the target
- **THEN** the read-state event source and the disposition set are unchanged
- **AND** no store commit occurs and nothing about the focus survives a reload

#### Scenario: focus never masquerades as the user's selection

- **GIVEN** the reviewer has element A selected
- **WHEN** the agent focuses an anchor in element B
- **THEN** the view-store selection still names element A (cursor and zoom may move; selection does not)

### Requirement: the fixed-point rule governs the moved surface

A focus jump SHALL move the viewport deliberately and exactly once per pointing: a re-render with the same focus SHALL NOT re-scroll, and after the jump the reviewer's own scrolling SHALL NOT be yanked back toward the focus.

#### Scenario: the surface does not fight the reviewer

- **WHEN** a focus jump lands and the reviewer then scrolls away
- **AND** the surface re-renders with the same focus state
- **THEN** the viewport stays where the reviewer put it

### Requirement: an unresolvable focus target is an honest no-op

A focus whose anchor is malformed, or resolves to an orphan (no-occurrence, no-such-side, out-of-bounds), SHALL produce no pulse, no scroll, and no crash, and SHALL NOT be re-anchored to any nearby span.

#### Scenario: no guessed anchor

- **WHEN** the agent focuses an anchor naming an occurrence absent from the rendered diff
- **THEN** the viewport does not move and no span pulses
- **AND** no substitute anchor is chosen

### Requirement: the reviewer's span selection mints a true span anchor

A line or range selection in the CodeView (the existing click / same-side shift-click gestures) SHALL be reported as a `rennet:` anchor whose span uses 1-based ordinals within the anchored occurrence's side — never absolute file lines — together with the selected lines' text. The minted anchor SHALL round-trip: parsing and resolving it yields exactly the originating rows.

#### Scenario: mint and resolve are inverse

- **WHEN** the reviewer selects rows in a hunk that does not start at line 1
- **THEN** the minted anchor parses under the RSP grammar
- **AND** resolving it against the same registry returns exactly the selected raw row indices, side-aware

#### Scenario: navigation clears the selection

- **WHEN** the reviewer navigates to another element or canvas
- **THEN** the current span selection is cleared and is not persisted anywhere

### Requirement: the selection rides the next ask at span granularity

An ask made while a span selection is current SHALL carry `{ anchor, excerpt }` on the `review.ask` input as a Zod-declared optional field, and main SHALL deliver it into the orchestrator session's context-update stream as a `selected` act whose anchor and excerpt reach the turn's rendered context byte-identically. An ask with no current selection SHALL produce a turn context with no `selected` event.

#### Scenario: a terse ask is disambiguated

- **WHEN** the reviewer selects a span and asks "is this safe?"
- **THEN** the turn's context contains a `selected` event carrying the span-bearing anchor and the selected lines' text, verbatim and inspectable

#### Scenario: no selection is never fabricated

- **WHEN** the reviewer asks with nothing selected
- **THEN** the turn's context contains no `selected` event — not an empty one, not one guessed from the open element

#### Scenario: the IPC field is declared, not stripped

- **WHEN** a `review.ask` input carrying `selection` crosses the invoke boundary
- **THEN** the validated input still carries the field byte-identically
- **AND** an input without `selection` remains valid (existing asks are untouched)
