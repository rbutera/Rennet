# Benchmark telemetry specification

## Purpose

Define default-on benchmark recording with honest stage breakdowns for Rennet's measured pipelines — the deterministic Repo Map build, lens drafting, and the post-round report — plus the Settings panel that renders the records and the repo-committed data that populates the docs benchmarks page.

## Requirements

### Requirement: Benchmark recording is a default-on setting with a Settings toggle

Debug benchmark recording SHALL be a persisted setting, enabled by default, with a visible toggle in the Settings surface. While enabled, the stages below record durable benchmark data; while disabled, no benchmark records are written. The toggle is observability configuration, never a consent gate on any pipeline.

#### Scenario: Fresh install records by default

- **WHEN** a fresh install runs a review with no settings changes
- **THEN** benchmark records exist for the run's stages

#### Scenario: Recording disabled

- **WHEN** the reviewer turns benchmark recording off and runs a review
- **THEN** no new benchmark records are written and the pipelines behave identically otherwise

### Requirement: Repo Map generation records per-stage timings

While recording is enabled, the deterministic Repo Map build SHALL durably record a timing for every build stage individually plus a `total` equal to the sum of that repository's own stage durations, labeled by stage name and bound to the generated snapshot's revision. There are no model-backed layers: the build is deterministic end to end.

#### Scenario: Map generation completes

- **WHEN** a Repo Map builds while recording is enabled
- **THEN** the benchmark record carries one timing per build stage and the total, each labeled and attributable

### Requirement: Lens drafting records per-lens and whole-process timings

While recording is enabled, lens drafting SHALL durably record, per lens: draft, dual-review, and any repair/post-process step timings, plus a per-lens total; and a whole-process timing across all lenses. These records SHALL share the per-phase timing spine required by the round-regeneration-reveal capability, not duplicate it.

#### Scenario: Five-lens generation completes

- **WHEN** lens drafting settles while recording is enabled
- **THEN** each lens has draft, dual-review, and repair timings plus a total, and the whole process has one end-to-end timing

### Requirement: The post-round report records its stage timing

While recording is enabled, the post-round report SHALL durably record its classification-turn timing and total report-gate duration, attributable to the round that produced it.

#### Scenario: Round report settles

- **WHEN** a coding round's report gate completes while recording is enabled
- **THEN** the benchmark record carries the report's stage timings bound to that round

### Requirement: Records carry per-stage harness resolution and every surface splits by derived mode

Every benchmark stage record SHALL carry the harness and model that actually executed that stage — Model Council routes per job, so one run may legitimately span providers across stages. Run-level mode labels — dual-model (Claude + Codex council), Claude-only, Codex-only — SHALL be derived from the recorded stages, never assumed from settings. The Settings benchmarks panel and the docs benchmarks page SHALL split or label their stage breakdowns by derived mode so the three modes are comparable and never averaged together silently.

#### Scenario: Codex-only run records its configuration

- **WHEN** a review runs on a Codex-only install while recording is enabled
- **THEN** every stage record carries its Codex resolution, the run derives the Codex-only label, and both the panel and the docs page present it under that mode

#### Scenario: Council run spans providers

- **WHEN** a dual-model run routes some lenses to Claude and others to Codex
- **THEN** each stage record names its own executor and the run derives the dual-model label

#### Scenario: Mixed history stays separated

- **WHEN** recorded history contains dual-model and Claude-only runs
- **THEN** no surface aggregates timings across configurations without labeling each mode distinctly

### Requirement: The Settings surface presents recorded benchmarks

The Settings surface SHALL contain a benchmarks panel that renders recorded runs with their stage breakdowns — Repo Map build stages, per-lens drafting, report — remaining responsive as history accumulates.

#### Scenario: Reviewer opens the benchmarks panel

- **WHEN** the reviewer opens Settings benchmarks after several recorded runs
- **THEN** each run's stage breakdown is visible and the panel renders without perceptible jank on a large history

### Requirement: Exported benchmark data populates the docs benchmarks page

An export SHALL land recorded benchmark data in the rennet repository in a form the documentation site renders as a dedicated benchmarks page with stage breakdowns for the Repo Map build, lens drafting, and the post-round report. The docs page SHALL render from that committed data, not hand-written numbers, and SHALL state the provenance (machine, date, change measured) of what it shows.

#### Scenario: Dogfood run refreshes the docs data

- **WHEN** a recorded dogfood run is exported and committed
- **THEN** the docs benchmarks page renders the new stage breakdowns from the committed data with their provenance

#### Scenario: Positive control breaks the data binding

- **WHEN** a control removes or corrupts the committed benchmark data
- **THEN** the docs build or its verification fails rather than rendering stale or invented numbers
