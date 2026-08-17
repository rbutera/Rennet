# codex-harness-adapter — locus-aware composition for WSL projects

## ADDED Requirements

### Requirement: The composition root composes locus-aware Codex invocations

For a WSL-locus project, the composition root SHALL compose the codex invocation to execute inside the distro: the spawn routes through the locus command wrapper (verbatim argv, no shell interpretation), the scratch directory backing output capture lives where the executing codex can read and write it, and every path handed to codex on argv (working directory, output capture, output schema) is in the distro-native form. For a host-locus project, composition is byte-identical to the shipped behavior. The adapter package itself SHALL remain transport-injected and process-free.

#### Scenario: A WSL-locus turn executes in the distro

- **WHEN** the composition root builds a codex turn for a WSL-locus project
- **THEN** the spawned command enters the named distro, the working-directory argument is the distro-native repo path, and the output-capture paths are readable by the in-distro codex

#### Scenario: Host composition is unchanged

- **WHEN** the composition root builds a codex turn for a host-locus project
- **THEN** the composed binary, argv, scratch placement, and cwd are identical to the pre-change behavior

### Requirement: The canvasOps loopback surface is reachable from the executing locus

The canvasOps URL handed to a codex session SHALL be an address the executing codex can actually reach: the shipped loopback for host execution, and for a WSL-locus session an address routable from the distro (shared localhost under mirrored networking, or the WSL-facing host address otherwise), with the listener bound no wider than that route requires. When no distro-reachable route can be established, the turn SHALL fail with a plain reason naming the gap — never silently execute on the host instead, and never claim canvas capability the session does not have.

#### Scenario: Distro codex reaches canvasOps

- **WHEN** a WSL-locus codex session starts and a distro-to-host route exists
- **THEN** the session's canvasOps URL is reachable from inside the distro and canvas operations round-trip

#### Scenario: No route degrades honestly

- **WHEN** no distro-reachable address can be established for the canvasOps listener
- **THEN** the codex turn settles as failed with a reason naming the unreachable canvas surface, and no host-side codex runs as a silent substitute
