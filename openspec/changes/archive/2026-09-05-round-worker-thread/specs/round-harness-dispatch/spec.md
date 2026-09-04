## MODIFIED Requirements

### Requirement: Round dispatch resolves the configured available harness

Round dispatch SHALL resolve the coding harness from the user's configuration and discovered availability, supporting Claude Code and Codex. Dispatch SHALL NOT hardcode a provider and SHALL NOT silently fall back to a provider other than the resolved one. When no configured harness is available, dispatch SHALL fail with a typed account naming what was sought and what was found.

#### Scenario: Codex-only install dispatches a round

- **WHEN** a user with only Codex installed and configured dispatches a coding round
- **THEN** the round runs through the Codex harness and completes its turn, its commit observation, and board regeneration

#### Scenario: Claude-only install dispatches a round

- **WHEN** a user with only Claude Code installed dispatches a coding round
- **THEN** the round runs through the Claude harness and completes the same workflow

#### Scenario: No configured harness is available

- **WHEN** round dispatch resolves and no configured harness is available
- **THEN** dispatch fails with a typed failure naming the resolution attempt, and no round is silently attempted on a different provider

### Requirement: Harness provenance is durable and visible in the round account

The round account SHALL durably record which harness executed the round, the session's bound workspace root the round ran in, and the sidecar checkpoint that captured the round's commits — which names the round's own thread. The client SHALL display that provenance, including a reference to the round's thread so the reviewer can open its transcript. Provenance SHALL reflect the harness and workspace that actually ran, never an assumed default, never a detached worktree path, and never the session's chat thread.

#### Scenario: Completed round shows its harness

- **WHEN** a round completes on either harness
- **THEN** the durable round account and the client's round surface both name that harness, the bound root, and the checkpoint reference identifying the round's own thread and turn

#### Scenario: A legacy account names what it has

- **WHEN** a round account written before this change is displayed
- **THEN** the surface shows only the provenance that row actually carries and states nothing it cannot prove
