# disposition-ui Specification

## Purpose
Defines disposition authoring at every review granularity, payload staging, read-state folding, and orphan recovery after patchset changes.
## Requirements
### Requirement: A disposition can be authored at every granularity, and the act traces to its per-anchor L2 writes
`authorDisposition` SHALL resolve an authoring act at line, hunk, symbol, element, cohort, or whole-roll-up granularity to its per-anchor L2 writes. It SHALL return one trace that binds the user act to every produced write and records the chosen granularity and target. A group act SHALL remain one user act that creates several per-anchor writes.

#### Scenario: A disposition at each anchor granularity creates the correct L2 events
- **WHEN** a disposition is authored at line, hunk, symbol, element, cohort, and roll-up granularity in turn
- **THEN** each act produces the correct set of per-anchor L2 writes and a single trace recording that granularity and its writes

### Requirement: The batch view is exactly the publish/handoff payload, and withdraw leaves zero residue
The batch SHALL be the L2 payload that Rennet will post to someone else's PR or hand off on the user's branch, assembled upsert-by-path. The rendered batch SHALL be byte-identical to the outbound payload. Withdrawing a draft before posting SHALL remove it entirely and leave no payload residue. Rennet SHALL carry the user's disposition body verbatim, including a brief or vague body.

#### Scenario: Batch view bytes equal the publish payload bytes
- **WHEN** a batch is assembled and its view model and its publish payload are serialised
- **THEN** the two byte sequences are equal

#### Scenario: Withdraw-before-publish leaves zero residue
- **WHEN** a draft carrying a unique sentinel is withdrawn from the batch
- **THEN** the sentinel appears nowhere in the resulting publish payload

### Requirement: Read-state is defined by actions only and rebuilds identically from event replay
Read-state SHALL be a pure fold over action-defined view events. A disposition action SHALL mark a path read. A path that the user scrolls through without acting on SHALL be at most skimmed. A collapsed or unseen path SHALL be unread. Collapse SHALL never mark anything read. Replaying the same events in any order SHALL yield identical coverage.

#### Scenario: A scrolled-through, never-actioned chunk reports skimmed, not read
- **WHEN** a path has a ScrolledPast event and no Actioned event
- **THEN** its read-state is skimmed, and never read

#### Scenario: Coverage figures rebuild identically from event replay
- **WHEN** the coverage mosaic is folded from an event list and again from the same events in reversed order
- **THEN** the two mosaics' cells and read/skimmed/unread figures are deep-equal

### Requirement: A disposition that fails to carry across a patchset advance surfaces in the orphan tray
When a patchset activates and the engine's conservative byte-identical carry drops a disposition, that disposition SHALL surface visibly in the orphan tray and never vanish silently. The orphan set SHALL be the dispositions present before the activation and absent after, keyed by anchor path and content digest.

#### Scenario: Orphan tray renders on a seeded failed-carry fixture
- **WHEN** a patchset activation carries one disposition forward and drops another
- **THEN** the dropped disposition appears in the orphan tray and the carried one does not
