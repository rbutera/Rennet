# Harness conformance specification

## Purpose
Define the shared conformance catalogue that derives harness capability evidence from refutable checks and records tested binary versions from real runs.
## Requirements
### Requirement: One suite, derived flags, exactly the passing set

The conformance suite SHALL define one check catalogue over the `HarnessPort` interface in `@rennet/core`, with no Node imports at module scope. It SHALL run the same checks against every adapter. Each check SHALL map to one `CapabilityName` and one evidence layer. A run SHALL return `CapabilityEvidence` for only the checks that passed, and `buildCapabilities` SHALL derive the descriptor's `true` flags from that evidence.

#### Scenario: Two adapters, two honest descriptors from one suite

- **WHEN** the suite runs against a Claude-shaped fake transport (which reports cost USD) and a codex-shaped fake transport (which does not)
- **THEN** both descriptors carry `structuredOutput` and `interrupt` as passing, `costUsd` is `true` only for the Claude-shaped run, and every unexercised capability remains `false` in every layer

#### Scenario: A skipped check leaves its flag false

- **WHEN** a check is not run for an adapter
- **THEN** the corresponding capability layer is `false`, the same result as a failed check

### Requirement: Every check is proven able to fail

Every suite run SHALL run a refuting control for every check. Each control SHALL use a deliberately broken port for that check and require the check to fail. A clean run where any control passes SHALL refuse certification rather than report capability evidence.

#### Scenario: One broken variant fails to refute its check

- **WHEN** the suite runs a check's deliberately broken variant and that variant nevertheless passes
- **THEN** the suite throws, reports no certification, and cannot record a tested range

### Requirement: Interrupt and context-window checks certify only direct evidence

The interrupt check SHALL begin draining, wait until the session is in flight, call only `session.interrupt()`, and require both a `cancelled` outcome and transport termination. The `reportsContextWindow` check SHALL pass only when the normalized protocol carries an actual positive context-window capacity; token usage alone SHALL NOT satisfy it.

#### Scenario: A no-op interrupt cannot pass

- **WHEN** an in-flight fake session implements `interrupt()` as a no-op
- **THEN** the interrupt check fails rather than being cancelled by an external signal

#### Scenario: Usage without capacity cannot pass

- **WHEN** a completed outcome carries token usage but no context-window capacity
- **THEN** `reportsContextWindow` remains false

### Requirement: Hermetic by default, real through opt-in tests

The default gate SHALL run the suite only against fake in-process transports, with no process spawn or token spend. Opt-in `.real` tests SHALL run against installed binaries. Only real runs SHALL produce `advertisedByHarness` or `availableInSession` evidence. Fake-transport runs SHALL produce at most `implementedByAdapter` evidence.

#### Scenario: The default gate spends nothing

- **WHEN** `pnpm check` runs the suite
- **THEN** no harness binary is spawned and no evidence beyond `implementedByAdapter` is produced

#### Scenario: an opt-in real run earns the outer layers

- **WHEN** the opt-in real run executes the suite against the installed binary
- **THEN** passing checks produce `advertisedByHarness`/`availableInSession` evidence for exactly those capabilities

### Requirement: testedRange is recorded from real runs, never hand-edited

A real conformance run SHALL record its binary version in the committed per-harness artifact only when every expected capability has the expected result. Each adapter's `testedRange` SHALL equal the minimum and maximum passing versions in that artifact. An adapter SHALL NOT declare a hand-written range or claim a range before a matching real run records one.

#### Scenario: A real run extends the recorded ceiling

- **WHEN** a real conformance run's complete result matches the expected capability matrix against a binary version above the artifact's recorded maximum
- **THEN** the artifact's recorded maximum becomes that version, and the descriptor's `testedRange.maxTested` follows the artifact

#### Scenario: A partially failing run does not extend the range

- **WHEN** a real run produces structured output but any other capability differs from the expected matrix
- **THEN** no tested-range entry is created or extended

#### Scenario: The descriptor never invents a range

- **WHEN** an adapter builds its descriptor
- **THEN** its `testedRange` equals the committed artifact's recorded range, with no other source
