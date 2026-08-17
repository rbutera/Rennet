# harness-conformance

The cross-adapter conformance suite (#25's core ask; deliberately excluded from the harness-adapter-protocol slice). One suite runs against every `HarnessPort`; each passing check flips exactly one capability layer from `false`; the descriptor's flags are exactly the passing set. Built once, it is what makes the codex slot and the later omp slot (#26) cheap.

## ADDED Requirements

### Requirement: One suite, derived flags, exactly the passing set

The conformance suite SHALL be a single check catalogue over the `HarnessPort` interface (pure `@rennet/core`, no Node at module scope), run identically against every adapter. Each check SHALL map to exactly one `CapabilityName` and one evidence layer, and a run's output SHALL be `CapabilityEvidence` naming only the checks that passed, fed to `buildCapabilities` — so a descriptor's `true` flags are exactly the passing set and nothing can declare a flag.

#### Scenario: Two adapters, two honest descriptors from one suite

- **WHEN** the suite runs against a Claude-shaped fake transport (which reports cost USD) and a codex-shaped fake transport (which does not)
- **THEN** both descriptors carry `structuredOutput` and `interrupt` as passing, `costUsd` is `true` only for the Claude-shaped run, and every unexercised capability remains `false` in every layer

#### Scenario: A skipped check leaves its flag false

- **WHEN** a check is not run for an adapter
- **THEN** the corresponding capability layer is `false`, indistinguishable from a failed check — absence of evidence is absence of capability

### Requirement: The suite is proven able to fail

Every suite run SHALL include a positive control: a deliberately broken transport (for example, one that completes without structured output) SHALL yield a failing check and a `false` flag. A clean run that cannot demonstrate the control failing SHALL NOT be reported as passing.

#### Scenario: The broken transport fails its check

- **WHEN** the suite runs its `structuredOutput` check against a transport that omits structured output
- **THEN** the check fails, the resulting evidence omits `structuredOutput`, and the built descriptor carries it `false`

### Requirement: Hermetic by default, real by gate

The default gate SHALL run the suite only against fake in-process transports — zero process spawns, zero token spend. Runs against the real installed binaries SHALL exist as gated `.real` tests (opt-in via environment), and only real runs SHALL produce `advertisedByHarness` / `availableInSession` evidence; fake-transport runs SHALL cap out at `implementedByAdapter`.

#### Scenario: The default gate spends nothing

- **WHEN** `pnpm check` runs the suite
- **THEN** no harness binary is spawned and no evidence beyond `implementedByAdapter` is produced

#### Scenario: A gated real run earns the outer layers

- **WHEN** the opt-in real run executes the suite against the installed binary
- **THEN** passing checks produce `advertisedByHarness`/`availableInSession` evidence for exactly those capabilities

### Requirement: testedRange is recorded from real runs, never hand-edited

A real conformance run SHALL record the binary version it ran against into a committed per-harness artifact, and each adapter's `testedRange` SHALL be derived from that artifact (min and max recorded passing version). No hand-written tested-range constant SHALL remain: the Claude adapter's existing hand-edited range migrates onto the same mechanism, seeded from its current values.

#### Scenario: A real run extends the recorded ceiling

- **WHEN** a real conformance run passes against a binary version above the artifact's recorded maximum
- **THEN** the artifact's recorded maximum becomes that version, and the descriptor's `testedRange.maxTested` follows the artifact

#### Scenario: The descriptor never invents a range

- **WHEN** an adapter builds its descriptor
- **THEN** its `testedRange` equals the committed artifact's recorded range, with no other source
