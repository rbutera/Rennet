# publish-safety-gate specification

## Purpose

The publish preview shows the exact outbound review or pull request and posts it through one accessible action. Incomplete-ingestion details remain visible, but they never block or delay the post.

## Requirements

### Requirement: Posting emits exactly the previewed bytes

The preview SHALL show the exact outbound payload. Activating its post control SHALL send that payload without another confirmation, timed hold, acknowledgement, or consent step.

#### Scenario: Post sends the previewed payload

- **WHEN** the user activates the post control from a GitHub-backed review preview
- **THEN** the outbound payload is byte-equal to the payload shown in the preview

#### Scenario: Keyboard activation posts

- **WHEN** the focused post control is activated with Enter or Space
- **THEN** the same post action runs with no pointer-only timing requirement

### Requirement: Posting clears the staged draft

A successful post SHALL clear the staged draft and close the preview. A failed post SHALL keep the draft and show the failure.

#### Scenario: Post succeeds

- **WHEN** the outbound post succeeds
- **THEN** the staged draft is empty and the preview closes

#### Scenario: Post fails

- **WHEN** the outbound post fails
- **THEN** the staged draft remains available and the preview reports the failure

### Requirement: The preview discloses incomplete ingestion without gating post

The preview SHALL display every incomplete-ingestion state before the post control. Each entry SHALL name its reason and human-facing detail. The disclosure SHALL NOT block, delay, or add an acknowledgement step to posting.

#### Scenario: Incomplete ingestion is visible

- **WHEN** a preview carries one or more incomplete-ingestion states
- **THEN** it names each state before the enabled post control

#### Scenario: Complete ingestion needs no disclosure

- **WHEN** the preview carries no incomplete-ingestion state
- **THEN** no incomplete-ingestion disclosure renders
