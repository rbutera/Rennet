# live-review-pipeline

The live wire-up that turns the fixtures demo into a real product: a captured working-tree changeset flows through decomposition, a budget-gated agentic angle, and the ordering pass into the five-angle canvas set the reviewer reads, delivered over IPC.

## ADDED Requirements

### Requirement: A captured changeset produces populated canvases

`buildReviewCanvases` SHALL transform a captured `Patchset` into the five-angle canvas set (`Record<CanvasAngle, Canvas>`) by composing `decompose` (#7), `runDecompositionAngle` (#8), the ordering pass (#9), and `buildCanvas` (#10). The canvas state SHALL derive from the captured diff — the substrate from the decomposition, the sequence from the admitted proposal or the deterministic floor — never from fixtures.

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
