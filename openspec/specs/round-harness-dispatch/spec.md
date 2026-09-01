# Round harness dispatch specification

## Purpose

Define how a coding round resolves and uses the reviewer's configured coding harness (Claude Code or Codex), so the supported-setup contract — either harness alone completes the core journey — is real behavior, not documentation.

## Requirements

### Requirement: Round dispatch resolves the configured available harness

Round dispatch SHALL resolve the coding harness from the user's configuration and discovered availability, supporting Claude Code and Codex. Dispatch SHALL NOT hardcode a provider and SHALL NOT silently fall back to a provider other than the resolved one. When no configured harness is available, dispatch SHALL fail with a typed account naming what was sought and what was found.

#### Scenario: Codex-only install dispatches a round

- **WHEN** a user with only Codex installed and configured dispatches a coding round
- **THEN** the round runs through the Codex harness and completes edit, gate, land, and board regeneration

#### Scenario: Claude-only install dispatches a round

- **WHEN** a user with only Claude Code installed dispatches a coding round
- **THEN** the round runs through the Claude harness and completes the same workflow

#### Scenario: No configured harness is available

- **WHEN** round dispatch resolves and no configured harness is available
- **THEN** dispatch fails with a typed failure naming the resolution attempt, and no round is silently attempted on a different provider

### Requirement: Harness provenance is durable and visible in the round account

The round account SHALL durably record which harness executed the round, and the client SHALL display that provenance. Provenance SHALL reflect the harness that actually ran, never an assumed default.

#### Scenario: Completed round shows its harness

- **WHEN** a round completes on either harness
- **THEN** the durable round account and the client's round surface both name that harness
