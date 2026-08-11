# model-council Specification

## Purpose
TBD - created by archiving change build-model-council-v1. Update Purpose after archive.
## Requirements
### Requirement: The council owns a versioned job catalogue
The Model Council SHALL hold a versioned `JOB_CATALOGUE` mapping every job to its tier (`light` | `heavy` | `deterministic`), its batching shape, and whether it rides another job's session. Job ids SHALL be stable. The catalogue is data shipped with the app; changing an assignment is a table edit, never a code change.

#### Scenario: The catalogue names every model-facing job
- **WHEN** the catalogue is read
- **THEN** it contains the light-tier jobs (chunk titles, claim extraction, disposition triage, noise narration, pattern proposal, publish prose, roll-up narration, PR-body draft, committed-spec requirement extraction, inferred test mapping, delta summary, finding dedupe, claim canonicalisation, comment refinement, handoff bundle, `context.ask` fetch), the heavy seats (decomposition skeleton, decomposition proposal and its riders, spec derivation, finding generation, comprehension ordering, anomaly spotting, orchestrator/diff chat, `context.ask` thorough, adjudication), and the deterministic-tier markers, each with a tier

### Requirement: resolveAssignment is pure and deterministic with a fixed resolution order
`resolveAssignment(jobId, ctx)` SHALL be a pure function of its inputs returning, for a model-facing job, `{ harness, model, effort, trace }`, and for a deterministic-tier job a `{ kind: "deterministic", trace }` result with no model. It SHALL resolve in the order: (1) an explicit per-task override, (2) an explicit per-tier override, (3) the council default table keyed by the availability scenario, (4) the harness default. A higher step overwrites only the fields it sets; a partial override (effort only) keeps the table's model.

#### Scenario: The council default table resolves each job under each availability scenario
- **WHEN** `resolveAssignment` is called for a model-facing job with no overrides under `both`, `claude-only`, and `codex-only`
- **THEN** it returns the `{ model, effort }` the corresponding assignment table (1, 2, 3) specifies, with the harness derived from the model's provider

#### Scenario: A task override wins over a tier override wins over the table
- **WHEN** a job has both a per-task and a per-tier override
- **THEN** the per-task override's fields win, the per-tier override fills any field the task override did not set, and the table fills the rest, and the trace records `task` as the winning source

#### Scenario: A deterministic-tier job resolves to no model
- **WHEN** `resolveAssignment` is called for a deterministic-tier job
- **THEN** the result is `{ kind: "deterministic" }` with a trace and no `model`

### Requirement: Cross-harness routing places light work on a different harness than the reviewer (R39)
Under the `both` scenario the council default table SHALL place light-tier work on a different installed harness than the heavy review sessions, so light thinking runs on the cheapest capable installed harness while the review stays on its harness. This preference is preferred over collapsing tiers within one harness.

#### Scenario: A light job and the reviewer resolve to different harnesses when both are installed
- **WHEN** both `claude-code` and `codex` are installed and `resolveAssignment` is called for a light job (chunk titles) and for the reviewer (decomposition proposal)
- **THEN** the light job resolves to the `codex` harness and the reviewer resolves to the `claude-code` harness

### Requirement: Every resolution carries an inspectable trace
`resolveAssignment` SHALL attach a structured trace recording the job, tier, availability scenario, winning source (`task` | `tier` | `council-table` | `harness-default` | `degraded`), and a human-readable summary string of the form "<job> ran on <model>-<effort> because: tier=<tier> · <scenario> · <source>". This is the string the UI can show so an override is only ever over something visible.

#### Scenario: The trace explains a table resolution
- **WHEN** a job resolves from the council default table with no override
- **THEN** its trace names the tier, the availability scenario, `council-table` as the source, and carries a human summary

