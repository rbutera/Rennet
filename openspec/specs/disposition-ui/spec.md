# disposition-ui Specification

## Purpose
TBD - created by archiving change build-disposition-ui. Update Purpose after archive.
## Requirements
### Requirement: A disposition can be authored at every granularity, and the act traces to its per-anchor L2 writes
`authorDisposition` SHALL resolve an authoring act at any altitude of the zoom ladder — line, hunk, symbol, element, cohort, or whole roll-up — to the per-anchor L2 disposition writes it covers, and SHALL return a trace binding that ONE user act to the several writes it produced, recording the altitude and what was acted on. A group act SHALL be one user act fanning out to per-anchor L2, never N separate acts.

#### Scenario: A disposition at each anchor granularity creates the correct L2 events
- **WHEN** a disposition is authored at line, hunk, symbol, element, cohort, and roll-up granularity in turn
- **THEN** each act produces the correct set of per-anchor L2 writes and a single trace recording that granularity and its writes

### Requirement: The batch view is exactly the publish/handoff payload, and withdraw leaves zero residue
The batch SHALL be the L2 payload that will publish (someone else's PR) or hand off (own branch), assembled upsert-by-path. The rendered batch view SHALL be byte-identical to the published payload. Withdrawing a draft before publish SHALL remove it entirely, leaving zero residue in the payload. The disposition body SHALL be the user's raw sovereign input; a lazy or vague body is supported and is carried verbatim.

#### Scenario: Batch view bytes equal the publish payload bytes
- **WHEN** a batch is assembled and its view model and its publish payload are serialised
- **THEN** the two byte sequences are equal

#### Scenario: Withdraw-before-publish leaves zero residue
- **WHEN** a draft carrying a unique sentinel is withdrawn from the batch
- **THEN** the sentinel appears nowhere in the resulting publish payload

### Requirement: Read-state is defined by actions only and rebuilds identically from event replay
Read-state SHALL be a pure fold over action-defined view events: a disposition action marks a path read; a scrolled-through-but-never-actioned path is at most skimmed; a collapsed or never-seen path is unread. Collapse SHALL never mark anything read. The fold SHALL be order-independent, so replaying the same events in any order yields identical coverage figures.

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

