# harness-conformance Specification

## Purpose
TBD - created by archiving change add-codex-app-server. Update Purpose after archive.
## Requirements
### Requirement: One suite, derived flags, exactly the passing set

The conformance suite SHALL be a single check catalogue over the `HarnessPort` interface (pure `@rennet/core`, no Node at module scope), run identically against every adapter. Each check SHALL map to exactly one `CapabilityName` and one evidence layer, and a run's output SHALL be `CapabilityEvidence` naming only the checks that passed, fed to `buildCapabilities` — so a descriptor's `true` flags are exactly the passing set and nothing can declare a flag.

#### Scenario: Two adapters, two honest descriptors from one suite

- **WHEN** the suite runs against a Claude-shaped fake transport (which reports cost USD) and a codex-shaped fake transport (which does not)
- **THEN** both descriptors carry `structuredOutput` and `interrupt` as passing, `costUsd` is `true` only for the Claude-shaped run, and every unexercised capability remains `false` in every layer

#### Scenario: A skipped check leaves its flag false

- **WHEN** a check is not run for an adapter
- **THEN** the corresponding capability layer is `false`, indistinguishable from a failed check — absence of evidence is absence of capability

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

### Requirement: Hermetic by default, real by gate

The default gate SHALL run the suite only against fake in-process transports — zero process spawns, zero token spend. Runs against the real installed binaries SHALL exist as gated `.real` tests (opt-in via environment), and only real runs SHALL produce `advertisedByHarness` / `availableInSession` evidence; fake-transport runs SHALL cap out at `implementedByAdapter`.

#### Scenario: The default gate spends nothing

- **WHEN** `pnpm check` runs the suite
- **THEN** no harness binary is spawned and no evidence beyond `implementedByAdapter` is produced

#### Scenario: A gated real run earns the outer layers

- **WHEN** the opt-in real run executes the suite against the installed binary
- **THEN** passing checks produce `advertisedByHarness`/`availableInSession` evidence for exactly those capabilities

### Requirement: testedRange is recorded from real runs, never hand-edited

A real conformance run SHALL record the binary version it ran against into a committed per-harness artifact only when every expected capability has the expected pass/fail result. Each adapter's `testedRange` SHALL be derived from that artifact (min and max recorded passing version). No hand-written tested-range constant SHALL remain: the Claude adapter's existing hand-edited range migrates onto the same mechanism, seeded from its current values as explicitly permitted. Codex SHALL have no committed seed until its first genuine real run fully matches the expected matrix.

#### Scenario: A real run extends the recorded ceiling

- **WHEN** a real conformance run's complete result matches the expected capability matrix against a binary version above the artifact's recorded maximum
- **THEN** the artifact's recorded maximum becomes that version, and the descriptor's `testedRange.maxTested` follows the artifact

#### Scenario: A partially failing run does not extend the range

- **WHEN** a real run produces structured output but any other capability differs from the expected matrix
- **THEN** no tested-range entry is created or extended

#### Scenario: The descriptor never invents a range

- **WHEN** an adapter builds its descriptor
- **THEN** its `testedRange` equals the committed artifact's recorded range, with no other source

