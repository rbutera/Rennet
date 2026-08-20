# Live end-to-end review specification

## Purpose
Define the production composition that connects captured review state, repository context, canvases, and the orchestrator without substituting fixture data.
## Requirements
### Requirement: A production `CanvasOpsBackend` composes the whole surface over live review state

A production composition SHALL implement every `CanvasOpsBackend` accessor over a live review. Canvas, diff, run, decomposition, identity, and view accessors SHALL read the in-memory `Review` and active `Patchset`. `projectMap`, `fileContext`, and `novelty` SHALL read the injected adapter slices. The composition root SHALL inject store-backed readers without adding a `core` import of `adapters`. An accessor without a live source SHALL return an empty result or a `stale` or `failed` freshness verdict. It SHALL NOT fabricate data.

#### Scenario: every accessor is backed by live state

- **WHEN** the production backend is built for a live review with a captured patchset and a generated snapshot
- **THEN** `canvas`, `decomposition`, `element`, `hunk`, and `searchDiff` return data derived from the captured diff
- **AND** `projectMap`, `fileContext`, and `novelty` return snapshot-derived results for the review's resolved base OID
- **AND** no accessor returns a value that a test fake would have supplied

#### Scenario: an unresolved source is honest, never faked

- **WHEN** an accessor's live source has no recorded data yet (for example an empty run ledger)
- **THEN** the accessor returns a distinguished empty or non-`current` result with its freshness verdict
- **AND** it never returns a fabricated entry

### Requirement: The backend resolves `repo → repoKey → base-OID` and the current patchset for real

The composition SHALL supply the injected resolvers the Repo-Map slices require from the live review: the context resolver SHALL return `{ repoKey, baseOid }` where `repoKey` is `realpath(git-common-dir)` of the review's repository root and `baseOid` is the active patchset's pinned base OID; the novelty resolver SHALL return `{ repoKey, patchset }` for the active patchset. Every read SHALL be judged fresh against that resolved OID; a snapshot at any other OID SHALL be refused as stale rather than served.

#### Scenario: context reads pin to the active patchset's base OID

- **WHEN** `context.map` or `context.file` is called on the live backend
- **THEN** the read resolves `repoKey`/`baseOid` from the current review and passes them through the fail-closed reader gate
- **AND** a snapshot built at a different OID is refused as `stale`, never served

#### Scenario: re-capture re-pins novelty

- **WHEN** the review's active patchset changes and `context.novelty` is called again
- **THEN** the novelty read resolves the NEW `{ repoKey, patchset }` and classifies against the new patchset's pinned base OID

### Requirement: The ProjectSnapshot is generated on review open so the Repo-Map serves real data

Creating a review SHALL generate (or confirm fresh) the deterministic `ProjectSnapshot` for the review's repo at the resolved base OID before the Repo-Map is read, and construct the readers over the snapshot store. Generation SHALL be fail-closed and model-free; when a snapshot cannot be produced or confirmed fresh, the Repo-Map reads SHALL return their typed gate failure rather than a served-but-wrong map, and review creation SHALL NOT fake a snapshot.

#### Scenario: snapshot present, repo map serves real data

- **WHEN** a review is created and its snapshot is generated fresh at the resolved base OID
- **THEN** `context.map` returns the deterministic structural map derived from that snapshot
- **AND** `context.file` returns the structural entry for a real repo-relative path

#### Scenario: snapshot unavailable refuses, never fakes

- **WHEN** the snapshot cannot be generated or is not fresh at the resolved base OID
- **THEN** `context.map` / `context.file` / `context.novelty` return a typed gate failure (`absent` | `stale` | `corrupt`)
- **AND** review creation does not serve a fabricated map

### Requirement: The orchestrator session is booted and served the live canvasOps@2 surface

The desktop composition root SHALL boot an orchestrator session (`attachOrchestratorSession`) bound to the production backend and hand the resulting in-process `canvasOps@2` MCP server to a live harness `query()`, so the descriptors the session's tool index names are exactly the ones a live model can call against real review state. Booting the session SHALL NOT spawn a model; a model runs only when the live query runs.

#### Scenario: the live orchestrator reads real repo-map data (gated proof)

- **WHEN** the gated live-harness proof drives one orchestrator turn against the production backend over a real review
- **THEN** a `context.map` or `context.novelty` tool call returns snapshot-derived data for the review's base OID
- **AND** the returned envelope carries a freshness verdict and its evidence, not a fixture

#### Scenario: booting the session spawns no model

- **WHEN** the composition root boots the orchestrator session and builds the MCP server
- **THEN** no harness process is spawned until a live query runs

### Requirement: Model-enriched canvases render on a slow harness

The live-canvas fetch SHALL survive the freshness poll: the canvas effect SHALL be keyed on `review.id` + `activePatchsetId`, SHALL record a canvas set as fetched only on success, and the periodic freshness poll SHALL NOT cancel an in-flight enrichment fetch through reference churn. On a regenerate the canvases SHALL re-fetch for the new patchset and SHALL NOT pin to the old one.

#### Scenario: slow harness eventually renders enriched canvases

- **WHEN** a review's enrichment fetch is slow and a freshness poll fires while it is in flight
- **THEN** the fetch is not cancelled-and-abandoned; the model-enriched canvases eventually render
- **AND** a fake-clock UI effect test with a slow fetch proves the retry

#### Scenario: regenerate re-fetches for the new patchset

- **WHEN** the active patchset changes (regenerate)
- **THEN** the canvas effect re-fetches for the new `activePatchsetId` and does not present the old patchset's canvases

### Requirement: The wired canvasOps@2 registry is structurally L2-free

A structural test SHALL assert that the WIRED `canvasOps@2` registry handed to the live orchestrator is a strict subset of `ORCHESTRATOR_CANVAS_OPS`, so the live surface can never contain an L2 disposition-writer. "The human still disposes" SHALL be a property of the wiring, not only of the model-level helper.

#### Scenario: the wired surface cannot contain an L2 writer

- **WHEN** the wired registry is compared against `ORCHESTRATOR_CANVAS_OPS`
- **THEN** every wired tool is a member of `ORCHESTRATOR_CANVAS_OPS`
- **AND** no wired tool is an L2 disposition-writer (adding one to the wired set makes the test fail)
