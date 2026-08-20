## REMOVED Requirements

### Requirement: A completed sign emits exactly the previewed bytes

**Reason**: Rennet posts from the preview directly. Signing is retired terminology and a separate signing ceremony violates Rule Zero.

**Migration**: Use the direct-post requirement below.

### Requirement: A hold below the budget never signs

**Reason**: A timed hold is a consent gate and is not part of the product contract.

**Migration**: Use one direct post action from the preview.

### Requirement: A keyboard user can complete the publish act deliberately

**Reason**: Keyboard access remains required, but it no longer needs a special signing or degradation-gate contract.

**Migration**: The ordinary post control must work with keyboard and assistive technology.

### Requirement: Signing clears the staged paper at the app level

**Reason**: The current product model is draft, preview, and post. It has no signed paper.

**Migration**: A successful post clears the staged draft and closes the preview.

### Requirement: A shell sign honestly discloses that nothing was published

**Reason**: The live product can post reviews and submit pull requests. A retired shell limitation is not a current requirement.

**Migration**: Local captures keep an honest preview-only state, while GitHub-backed reviews use the real post path.

### Requirement: The publish sheet discloses blocked ingestion before signing

**Reason**: The disclosure stays, but signing terminology and gate mechanics do not.

**Migration**: Use the direct-post disclosure requirement below.

## ADDED Requirements

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

The preview SHALL display any incomplete-ingestion states before the post control. The disclosure SHALL NOT block, delay, or add an acknowledgement step to posting.

#### Scenario: Incomplete ingestion is visible

- **WHEN** a preview carries one or more incomplete-ingestion states
- **THEN** it names each state before the enabled post control

#### Scenario: Complete ingestion needs no disclosure

- **WHEN** the preview carries no incomplete-ingestion state
- **THEN** no incomplete-ingestion disclosure renders
