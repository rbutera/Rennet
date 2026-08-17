# model-council delta

## MODIFIED Requirements

### Requirement: resolveAssignment is pure and deterministic with a fixed resolution order

`resolveAssignment(jobId, ctx)` SHALL be a pure function of its inputs returning, for a model-facing job, `{ harness, model, effort, trace }`, and for a deterministic-tier job a `{ kind: "deterministic", trace }` result with no model. It SHALL resolve in the order: (1) an explicit per-task override, (2) an explicit per-tier override, (3) the council default table keyed by the availability scenario, (4) the harness default. A higher step overwrites only the fields it sets; a partial override (effort only) keeps the table's model. Overrides SHALL carry `model` and `effort` only — an override cannot pin `harness` independently. After all model and effort resolution, including degraded and missing-table fallbacks, `harness` SHALL be derived exactly once from the resolved model's provider. A contradictory `harnessDefault.harness` is therefore ignored in favour of the model provider, keeping result, provenance, and trace coherent.

#### Scenario: The council default table resolves each job under each availability scenario

- **WHEN** `resolveAssignment` is called for a model-facing job with no overrides under `both`, `claude-only`, and `codex-only`
- **THEN** it returns the `{ model, effort }` the corresponding assignment table (1, 2, 3) specifies, with the harness derived from the model's provider

#### Scenario: A task override wins over a tier override wins over the table

- **WHEN** a job has both a per-task and a per-tier override
- **THEN** the per-task override's fields win, the per-tier override fills any field the task override did not set, and the table fills the rest, and the trace records `task` as the winning source

#### Scenario: An overridden model always runs on its own provider's harness

- **WHEN** a task override pins a model belonging to the other provider than the job would otherwise resolve to
- **THEN** the resolution's `harness` is the pinned model's provider harness, and the trace summary records that same harness — no input can produce a resolution whose model and harness name different providers

#### Scenario: A degraded harness default cannot produce an incoherent pair

- **WHEN** no provider is installed and the harness default names `claude-code` with a Codex model
- **THEN** the resolved harness is `codex`, derived from that model after fallback resolution, and the trace records the coherent pair

#### Scenario: A deterministic-tier job resolves to no model

- **WHEN** `resolveAssignment` is called for a deterministic-tier job
- **THEN** the result is `{ kind: "deterministic" }` with a trace and no `model`
