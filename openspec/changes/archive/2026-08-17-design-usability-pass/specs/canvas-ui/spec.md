## ADDED Requirements

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
