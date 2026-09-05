## MODIFIED Requirements

### Requirement: Harness provenance is durable and visible in the round account

The round account SHALL durably record which harness executed the round, the session's bound workspace root the round ran in, and the sidecar checkpoint that captured the round's commits; the client SHALL display that provenance. Provenance SHALL reflect the harness and workspace that actually ran, never an assumed default and never a detached worktree path.

#### Scenario: Completed round shows its harness

- **WHEN** a round completes on either harness
- **THEN** the durable round account and the client's round surface both name that harness, the bound root, and the checkpoint reference
