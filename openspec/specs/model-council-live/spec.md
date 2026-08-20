# Live model council specification

## Purpose
Define how live review seats execute on their resolved Claude or Codex harness while sharing one invocation budget and recording accurate provenance.
## Requirements
### Requirement: The Codex port is executable as an injected turn

`createCodexRunTurn` SHALL adapt a `CodexUtilityPort` into the injected `runTurn` used by `runDecompositionAngle`/`runOrderingPass` for a Codex-resolved seat, running exactly one `port.complete` per turn with `maxRetries: 0` so the runner's shared budget and retry loop remain the single authority. It SHALL depend only on the port interface, not on any concrete adapter package.

#### Scenario: admitted document becomes an emitted body

- **WHEN** the port admits the emitted document for a turn
- **THEN** `runTurn` returns an emitted body carrying the admitted document's body

#### Scenario: rejection or exec failure becomes a turn failure

- **WHEN** the port rejects the document, or the executor fails
- **THEN** `runTurn` returns a turn failure so the runner retries and the deterministic floor can stand

#### Scenario: exactly one port call per turn

- **WHEN** `runTurn` is invoked once
- **THEN** the port's `complete` is called exactly once with `maxRetries: 0` (the runner, not the port, owns retries and the shared budget)

### Requirement: The council resolves each seat and executes it on the resolved harness

When given a council context, `buildReviewCanvases` SHALL resolve each model-facing seat through `resolveAssignment` and execute it on the resolved harness. This includes `decomposition-proposal` and `comprehension-ordering`. A `claude-code` seat SHALL run the injected Claude turn. A `codex` seat SHALL run the injected `CodexUtilityPort`. The model phase SHALL run when the decomposition seat has an executor for its resolved harness.

#### Scenario: both harnesses split the light and review seats

- **WHEN** the council availability is `both`, a Claude turn and a fake Codex port are injected, and the pipeline runs
- **THEN** the decomposition proposal executes via the Claude turn and the ordering seat (resolved to a Codex model under `both`) executes via the Codex port
- **AND** the injected Claude ordering turn is NOT called for the ordering seat

#### Scenario: Claude is the only available harness

- **WHEN** the council availability is `claude-only`
- **THEN** both seats resolve to Claude models and execute via the injected Claude turns, and the Codex port is never called

#### Scenario: Codex is the only available harness

- **WHEN** the council availability is `codex-only` and a fake Codex port is injected
- **THEN** both the heavy proposal seat and the ordering seat resolve to Codex models and execute via the Codex port, and no Claude turn is called

### Requirement: Provenance agrees on model, effort, and harness for each seat

`buildReviewCanvases` SHALL stamp each seat's provenance with the resolved `model`, `effort`, `harness`, and `resolutionTrace` such that the `harness` follows the resolved model. A seat resolved to a Codex model SHALL never be stamped with a Claude harness (and vice versa).

#### Scenario: cross-harness seats stamp honest harness

- **WHEN** the council resolves the proposal seat to a Claude model and the ordering seat to a Codex model
- **THEN** the proposal provenance stamps a Claude harness and the ordering provenance stamps a Codex harness
- **AND** neither seat pairs a Codex model with a Claude harness

#### Scenario: the trace records the resolved seat

- **WHEN** a seat is resolved by the council
- **THEN** its provenance carries the resolution trace whose summary names the resolved model

#### Scenario: no council context uses the injected decomposition turn

- **WHEN** no council context is supplied
- **THEN** the caller-supplied provenance model stands and no resolution trace is stamped

### Requirement: One shared invocation budget gates every seat on the live path

`buildReviewCanvases` SHALL enforce one shared invocation budget across every seat, including reviews that use both Claude and Codex. The budget SHALL cover initial attempts and retries on either harness. A turn beyond the ceiling SHALL return a refusal and use the deterministic floor.

#### Scenario: the sixth turn is refused across a Claude seat and a Codex seat

- **WHEN** the ceiling is five, the proposal seat runs on Claude and always rejects, and the ordering seat runs on the Codex port and always rejects
- **THEN** exactly five turns run combined across the two harnesses and the sixth is refused
- **AND** both seats fall to the deterministic floor and the canvases still render

### Requirement: Codex availability is probed honestly

`discoverCodexAvailability` SHALL determine whether the `codex` binary is installed by running `codex --version` through an injected run seam, returning `{ available, version }`, so the composition root can gate `codex` availability without a real spawn in tests.

#### Scenario: a successful version probe reports available

- **WHEN** the injected run returns exit code 0 with a version on stdout
- **THEN** the probe reports `available: true` with the parsed version

#### Scenario: a failed probe reports unavailable

- **WHEN** the injected run exits non-zero or throws (no `codex` on PATH)
- **THEN** the probe reports `available: false`
