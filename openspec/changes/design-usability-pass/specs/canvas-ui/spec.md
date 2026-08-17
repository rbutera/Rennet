## ADDED Requirements

### Requirement: Conversation threads align in-rail to their anchor line

When a conversation thread's anchor row is rendered in the windowed diff, the thread panel in the conversation rail SHALL be vertically positioned so its top aligns with that row, keyed through the panel's existing `data-anchor-key`. When the anchor row is not rendered (scrolled outside the diff window), the panel SHALL fall back to stacked document order — never a fabricated position and never hidden. Alignment SHALL NOT reflow the diff column: the rail remains a sibling column of fixed width and the per-row discuss glyph continues to consume no grid track.

#### Scenario: a visible anchor row aligns its thread

- **WHEN** a conversation thread's anchor row is rendered inside the diff window
- **THEN** the thread panel carries an alignment offset derived from that row's rendered position, and the diff column's layout is unchanged by the panel's presence

#### Scenario: an off-screen anchor falls back honestly

- **WHEN** the anchor row is outside the rendered diff window
- **THEN** the thread panel renders in stacked document order in the rail, still reachable and readable, with no synthetic offset

#### Scenario: alignment never reflows the diff

- **WHEN** thread panels are aligned, added, or removed in the rail
- **THEN** the diff column's width and row positions are unaffected
