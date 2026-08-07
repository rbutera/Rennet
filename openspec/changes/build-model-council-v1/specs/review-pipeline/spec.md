## MODIFIED Requirements

### Requirement: The pipeline enforces one shared invocation budget across the whole model phase
`buildReviewCanvases` SHALL create ONE invocation budget seeded from `maxHarnessInvocations` and thread it through both `runDecompositionAngle` and `runOrderingPass`, so the total number of model turns across the decomposition-plus-ordering phase of a single review cannot exceed the ceiling regardless of retries. The pre-flight `buildRoutePlan` refusal (which skips the whole model phase for an over-budget diff shape before any spend) SHALL remain; the shared live budget is what makes the ceiling real for retries and the ordering phase. Every live model-invoking path in the pipeline SHALL be behind the budget.

#### Scenario: The pipeline refuses a sixth invocation at runtime
- **WHEN** the pipeline runs a decomposition proposal that retries and an ordering pass that retries such that six turns would otherwise be issued
- **THEN** the two runners' `runTurn` spies are called exactly five times combined and both phases fall to the deterministic floor

### Requirement: The pipeline selects the model per phase and stamps the resolution into provenance
When `buildReviewCanvases` is given a council context (installed harnesses plus user overrides), it SHALL call `resolveAssignment` for the `decomposition-proposal` and `comprehension-ordering` jobs and stamp the resolved `model`, `effort`, and structured `resolutionTrace` into each phase's provenance seed, so every model invocation's provenance carries `{ model, effort, trace }`. When no council context is supplied the pipeline SHALL preserve today's behaviour (the caller-supplied seed model).

#### Scenario: Provenance carries the resolved model, effort, and trace
- **WHEN** the pipeline runs with a council context under `both`
- **THEN** the decomposition proposal document's provenance carries the resolved model and effort and a resolution trace, and the reviewer's harness differs from a light job's harness
