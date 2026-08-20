# review-pipeline specification

## Purpose

The review pipeline resolves each model-backed phase through the Model Council and records the selected model, effort, and resolution trace in the phase provenance.

## Requirements

### Requirement: The pipeline selects the model per phase and stamps the resolution into provenance
When `buildReviewCanvases` receives a council context with installed providers and user overrides, it SHALL call `resolveAssignment` for the `decomposition-proposal` and `comprehension-ordering` jobs. It SHALL record the resolved `model`, `effort`, and structured `resolutionTrace` in each phase's provenance seed. Without a council context, the pipeline SHALL use the caller-supplied seed model.

#### Scenario: Provenance carries the resolved model, effort, and trace
- **WHEN** the pipeline runs with a council context under `both`
- **THEN** the decomposition proposal document's provenance carries the resolved model and effort and a resolution trace, and the reviewer's harness differs from a light job's harness
