# Model council specification

## Purpose
Define the versioned job catalogue and deterministic assignment policy that choose a model, effort level, and matching harness for each model-backed job.
## Requirements
### Requirement: The council owns a versioned job catalogue
The Model Council SHALL hold a versioned `JOB_CATALOGUE` mapping every job to its tier (`light` | `heavy` | `deterministic`), batching shape, and shared-session behavior. Job ids SHALL be stable. Assignments SHALL live in the catalogue's tables rather than control-flow branches.

#### Scenario: The catalogue names every model-facing job
- **WHEN** the catalogue is read
- **THEN** it contains the light-tier jobs (chunk titles, claim extraction, disposition triage, noise narration, pattern proposal, publish prose, roll-up narration, PR-body draft, committed-spec requirement extraction, inferred test mapping, delta summary, finding dedupe, claim canonicalisation, comment refinement, handoff bundle, `context.ask` fetch), the heavy seats (decomposition skeleton, decomposition proposal and its riders, spec derivation, finding generation, comprehension ordering, anomaly spotting, orchestrator/diff chat, `context.ask` thorough, adjudication), and the deterministic-tier markers, each with a tier

### Requirement: resolveAssignment is pure and deterministic with a fixed resolution order

`resolveAssignment(jobId, ctx)` SHALL be a pure function. For a model-facing job, it SHALL return `{ harness, model, effort, trace }`. For a deterministic-tier job, it SHALL return `{ kind: "deterministic", trace }` without a model. Resolution order SHALL be an explicit task override, an explicit tier override, the council table for the availability scenario, then the harness default. Each source SHALL replace only the fields it sets, so an effort-only override keeps the table's model. Overrides SHALL contain only `model` and `effort`; they SHALL NOT pin `harness`. After resolving model and effort, `resolveAssignment` SHALL derive the harness once from the model's provider. It SHALL ignore a contradictory `harnessDefault.harness`.

#### Scenario: The council default table resolves each job under each availability scenario

- **WHEN** `resolveAssignment` is called for a model-facing job with no overrides under `both`, `claude-only`, and `codex-only`
- **THEN** it returns the `{ model, effort }` the corresponding assignment table (1, 2, 3) specifies, with the harness derived from the model's provider

#### Scenario: A task override wins over a tier override wins over the table

- **WHEN** a job has both a per-task and a per-tier override
- **THEN** the per-task override's fields win, the per-tier override fills any field the task override did not set, and the table fills the rest, and the trace records `task` as the winning source

#### Scenario: An overridden model always runs on its own provider's harness

- **WHEN** a task override pins a model belonging to the other provider than the job would otherwise resolve to
- **THEN** the resolution's `harness` is the pinned model's provider harness, and the trace summary records the same harness

#### Scenario: A degraded harness default cannot produce an incoherent pair

- **WHEN** no provider is installed and the harness default names `claude-code` with a Codex model
- **THEN** the resolved harness is `codex`, derived from that model after fallback resolution, and the trace records the coherent pair

#### Scenario: A deterministic-tier job resolves to no model

- **WHEN** `resolveAssignment` is called for a deterministic-tier job
- **THEN** the result is `{ kind: "deterministic" }` with a trace and no `model`

### Requirement: Cross-harness routing places light work on a different harness than the reviewer
Under the `both` scenario the council default table SHALL place light-tier work on a different installed harness than the heavy review sessions, so light thinking runs on the cheapest capable installed harness while the review stays on its harness. This preference is preferred over collapsing tiers within one harness.

#### Scenario: A light job and the reviewer resolve to different harnesses when both are installed
- **WHEN** both `claude-code` and `codex` are installed and `resolveAssignment` is called for a light job (chunk titles) and for the reviewer (decomposition proposal)
- **THEN** the light job resolves to the `codex` harness and the reviewer resolves to the `claude-code` harness

### Requirement: Every resolution carries an inspectable trace
`resolveAssignment` SHALL attach a structured trace containing the job, tier, availability scenario, and winning source. The source SHALL be one of `task`, `tier`, `council-table`, `harness-default`, or `degraded`. The trace SHALL also contain a summary in the form `<job> ran on <model>-<effort> because: tier=<tier> · <scenario> · <source>`. The UI can display this summary with any override.

#### Scenario: The trace explains a table resolution
- **WHEN** a job resolves from the council default table with no override
- **THEN** its trace names the tier, the availability scenario, `council-table` as the source, and carries a human summary
