# canvas-ui — adopt the aligned conversation margin rail in the review heart

## MODIFIED Requirements

### Requirement: ConversationMargin aligns against a supplied rendered diff

When `ConversationMargin` receives a diff ref and a conversation thread's anchor row is rendered beneath that ref, the component SHALL vertically position each thread panel using `rowTop - panelNaturalTop`, keyed through the panel's existing `data-anchor-key`. When the diff ref or anchor row is absent, the component SHALL fall back to stacked document order — never a fabricated position and never hidden. The component SHALL only transform panels in its rail and SHALL NOT write to or reflow the supplied diff. The review heart SHALL thread a live diff ref from the rendered diff surface through the conversation column into `ConversationMargin`, so the aligned rail is the live app behavior rather than a dormant contract.

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

## ADDED Requirements

### Requirement: Rendered diff rows carry queryable anchor identity

The rendered diff surface SHALL stamp each content row with the anchor-key identity of the line it renders, and the chunk container SHALL carry its chunk anchor key, so an anchored conversation thread's row can be located by anchor key within the supplied diff ref. An anchor whose key matches no rendered row (including a range anchor that spans rather than matches a single row, and any row scrolled out of the render window) SHALL resolve to no element, and the thread SHALL render in the stacked fallback — never at a fabricated position.

#### Scenario: a line-anchored thread's row is discoverable

- **WHEN** the diff surface renders a row for a line that an open conversation thread is anchored to
- **THEN** querying the diff ref by that thread's anchor key locates exactly that row

#### Scenario: an off-window or unmatched anchor resolves to nothing

- **WHEN** a thread's anchor row is outside the current render window, or the anchor's key grammar does not identify a single rendered row
- **THEN** the anchor-key query finds no element and the thread panel renders stacked, reachable, and unhidden

### Requirement: The review heart's conversation column renders the aligned margin path

The review heart SHALL render its conversation column through the aligned margin path — one panel per thread, each carrying its anchor key, aligned when its anchor row is rendered and stacked otherwise — while preserving the existing conversational affordances (asking, promoting, sub-threads) and the sibling-column structure in which conversation layout never reflows the diff. Alignment SHALL re-measure across the windowed diff lifecycle (scroll, resize, diff-size change) without user action. Nothing in the aligned path SHALL gate, confirm, or block any review action (Rule Zero).

#### Scenario: scrolling the windowed diff re-aligns without reflow

- **WHEN** the user scrolls the diff so a thread's anchor row enters or leaves the render window
- **THEN** the thread's panel gains or loses its alignment offset accordingly, and the diff column's row positions are unaffected

#### Scenario: conversational affordances survive adoption

- **WHEN** the review heart renders the aligned margin path
- **THEN** a thread panel still offers its ask, promote, and sub-thread actions with unchanged behavior
