# review-pipeline Specification

## Purpose
TBD - created by archiving change build-model-council-v1. Update Purpose after archive.
## Requirements
### Requirement: The pipeline selects the model per phase and stamps the resolution into provenance
When `buildReviewCanvases` is given a council context (installed harnesses plus user overrides), it SHALL call `resolveAssignment` for the `decomposition-proposal` and `comprehension-ordering` jobs and stamp the resolved `model`, `effort`, and structured `resolutionTrace` into each phase's provenance seed, so every model invocation's provenance carries `{ model, effort, trace }`. When no council context is supplied the pipeline SHALL preserve today's behaviour (the caller-supplied seed model).

#### Scenario: Provenance carries the resolved model, effort, and trace
- **WHEN** the pipeline runs with a council context under `both`
- **THEN** the decomposition proposal document's provenance carries the resolved model and effort and a resolution trace, and the reviewer's harness differs from a light job's harness

