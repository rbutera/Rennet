## ADDED Requirements

### Requirement: A round's work order names the repository's check command when one is known

The work order composed for a coding round SHALL carry, alongside its commit rule, an instruction to run the repository's discovered check command before committing, to commit only when it passes, and to state in the final message why it could not when it fails. The instruction SHALL name the command exactly as the project scout discovered it, bounded to a fixed size with an honest truncation marker beyond it. When the scout discovered no check command, the work order SHALL omit the instruction entirely rather than render it with an empty command. The review handoff's work order, which forbids git entirely, SHALL be unaffected.

#### Scenario: The command is known

- **WHEN** a round's work order is composed for a repository whose scout discovered `pnpm check`
- **THEN** both the turn's prompt and the `work-order.md` file it names carry one instruction to run `pnpm check` before committing

#### Scenario: The command is unknown

- **WHEN** a round's work order is composed for a repository with no discovered check command
- **THEN** neither the prompt nor the work-order file mentions a check command, and no placeholder is rendered

#### Scenario: The review handoff is unchanged

- **WHEN** a review handoff bundle is composed
- **THEN** its work order still forbids git entirely and carries no check instruction
