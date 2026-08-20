# Live review pipeline specification

## Purpose
Define how a captured patchset becomes the five live review canvases, their source diffs, and the desktop commands that read and mutate review state.
## Requirements
### Requirement: A captured changeset produces populated canvases

`buildReviewCanvases` SHALL transform a captured `Patchset` into the five-angle canvas set, typed as `Record<CanvasAngle, Canvas>`. It SHALL compose `decompose`, `runDecompositionAngle`, the ordering pass, and `buildCanvas`. The decomposition supplies the chunks. The admitted ordering proposal or deterministic floor supplies the sequence. Fixture data SHALL NOT enter this path.

#### Scenario: real diff, admitted agentic proposal

- **WHEN** `buildReviewCanvases` runs on a real patchset with an injected turn that emits a valid `decomposition.proposal`
- **THEN** all five canvases are present, keyed by angle
- **AND** the substrate layer carries the decomposition's chunks and the sequence canvas presents the admitted proposal's chunk elements

#### Scenario: no harness available

- **WHEN** `buildReviewCanvases` runs with no injected decomposition turn
- **THEN** the canvases are still populated from the deterministic floor (substrate + deterministic sequence) and no error is thrown

### Requirement: The Brita budget filter gates before any model call

`buildReviewCanvases` SHALL compute the route-plan budget (`buildRoutePlan`) before running any model turn. A route plan that exceeds the invocation ceiling SHALL refuse, and on a refusal no injected turn SHALL be invoked; the pipeline SHALL stand on the deterministic floor.

#### Scenario: over-budget refuses before spending

- **WHEN** the route plan for the decomposition exceeds the invocation ceiling
- **THEN** the injected decomposition turn is never called
- **AND** the canvases are still populated from the deterministic floor

#### Scenario: within budget runs the turn

- **WHEN** the route plan is within the ceiling
- **THEN** the injected decomposition turn is called

### Requirement: The injected turn maps a harness session to a decomposition turn

`createHarnessRunTurn` SHALL adapt a `HarnessPort` into the injected `runTurn` used by `runDecompositionAngle`/`runOrderingPass`, creating a session constrained to the docType's output schema and mapping the session outcome. It SHALL depend only on the harness interface, not on any concrete adapter package.

#### Scenario: completed with structured output

- **WHEN** the harness session ends completed with a structured output
- **THEN** `runTurn` returns an emitted body carrying that structured output

#### Scenario: no structured output or a failure

- **WHEN** the harness session ends completed without structured output, or failed, or cancelled, or emits an error frame
- **THEN** `runTurn` returns a turn failure so the angle's deterministic fallback stands

### Requirement: The six canvas user commands round-trip through desktop dispatch

Desktop command dispatch SHALL route the six `canvas.*` user commands so a renderer invocation returns real data rather than `undefined`. `canvas.disposition` SHALL map onto the review's `setDisposition` (the sovereign L2 write) and return the updated review.

#### Scenario: canvas.disposition returns a real review

- **WHEN** a renderer invokes `canvas.disposition` against the active patchset
- **THEN** dispatch returns the updated review with the disposition recorded, not `undefined`

#### Scenario: the L3 ops acknowledge

- **WHEN** a renderer invokes `canvas.pinAnnotation`, `canvas.clearAnnotation`, `canvas.setCohortExpansion`, or `canvas.select`
- **THEN** dispatch returns a success acknowledgement rather than `undefined`

### Requirement: The renderer reads live canvases over IPC and keeps the demo

The `review.canvases` command SHALL deliver the live five-angle canvas set to the renderer. The canvas view SHALL render the live set when a real review is present and the fetch succeeds, and SHALL fall back to the fixtures demo when there is no review or the fetch fails, so the clickable demo never regresses.

#### Scenario: real review renders live canvases

- **WHEN** a real review exists and `review.canvases` returns a canvas set
- **THEN** the canvas view renders the live canvases

#### Scenario: fetch failure keeps the demo

- **WHEN** `review.canvases` fails or no review exists
- **THEN** the canvas view renders the fixtures demo and remains clickable

### Requirement: The canvas response carries a real per-element diff map

`buildReviewCanvases` SHALL produce an `elementDiffs` map keyed by `elementKey` alongside the five-angle canvas set. Each entry SHALL carry the changed file `path` and `diff` text sliced verbatim from the captured `Patchset`. It SHALL NOT reconstruct the diff from separated add, delete, and context arrays or use a fixture. The `review.canvases` command SHALL return the map to the renderer.

The map SHALL be a pure function of `(canvases, decomposition, patchset)`: identical inputs SHALL yield an identical map.

#### Scenario: a chunk element resolves to its real captured hunk

- **WHEN** `buildReviewCanvases` runs on a real patchset (deterministic floor, no model turn)
- **THEN** the sequence canvas's chunk element has an `elementDiffs` entry whose `path` is the changed file
- **AND** the entry's `diff` contains the real added and context lines exactly as captured in the patch
- **AND** the `diff` contains no `demoDiff` fixture signature

#### Scenario: a doc-anchored element has no diff

- **WHEN** an element's anchor is not a `chunk` or `hunk` anchor (a flat-angle document element)
- **THEN** it has no `elementDiffs` entry, so the zoom surface renders nothing rather than a fixture

### Requirement: The zoom surface renders the real diff on the real path

The canvas UI SHALL render the `elementDiffs` diff for the selected element when a real review is loaded, replacing the `demoDiff` fixture. The fixtures demo path SHALL be unchanged: when no real canvas set has loaded, zooming SHALL still render the demo diff, so the clickable demo never regresses.

#### Scenario: real review shows real code

- **WHEN** a real canvas set has loaded and the user zooms into an element that has an `elementDiffs` entry
- **THEN** the diff surface renders that real diff, not `demoDiff`

#### Scenario: the fixtures demo is preserved

- **WHEN** no real canvas set has loaded (the fixtures demo is on screen)
- **THEN** zooming still renders the demo diff, unchanged
