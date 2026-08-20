# destination-frame Specification

## Purpose
Defines the persistent destination that stages dispositions and previews the exact handoff or GitHub review payload.
## Requirements
### Requirement: The destination is persistent and present from review-open, even with nothing staged
The UI SHALL render a persistent destination from the moment a review opens. With an empty staged set, the destination SHALL remain visible and name what the user is building. It SHALL appear in both Files and Canvases views.

#### Scenario: The destination renders at review-open with an empty staged set
- **WHEN** a review is open and no disposition has been made
- **THEN** the destination target is rendered and names what the user is staging toward, with an empty staged set shown rather than hidden

### Requirement: A disposition is staged the moment it is made, and withdraw unstages it with zero residue
Making a disposition SHALL stage it into the destination's payload in the same act, with no separate staging step (dispose == staged). Withdrawing a staged disposition SHALL unstage it entirely, leaving zero residue in the payload (withdraw == unstage). The destination SHALL fill visibly as the staged set grows.

#### Scenario: Disposing stages the item in one act
- **WHEN** a disposition is authored at any granularity
- **THEN** the resulting write appears in the destination's staged payload without any further staging act

#### Scenario: Withdraw leaves zero residue
- **WHEN** a staged disposition carrying a unique sentinel is withdrawn
- **THEN** the sentinel appears nowhere in the resulting staged payload

### Requirement: The destination has two variants selected by mode over the same staged data
The destination SHALL present the same staged set in two modes. `own-branch` SHALL present the handoff or PR-submission bundle. `other-pr` SHALL present the GitHub review that will be posted. The staged data SHALL remain identical while the title, summary, and action label change with the mode.

#### Scenario: Mode switches the variant over the same staged data
- **WHEN** the same staged set is rendered as `own-branch` and then as `other-pr`
- **THEN** the two renders show distinct framing (handoff bundle vs review to post) while the staged item set is identical

### Requirement: The preview posts exactly what it shows
The preview SHALL list the staged items as the exact outbound artifact. Posting SHALL be one action over the whole staged set, with no timed hold or separate confirmation. To post a subset, the user SHALL withdraw the other items before opening the preview.

#### Scenario: Preview bytes equal outbound bytes
- **WHEN** the preview renders a staged set and the outbound payload is serialized
- **THEN** the two byte sequences are equal

#### Scenario: One action posts the staged set
- **WHEN** the user activates post on a GitHub-backed preview
- **THEN** Rennet sends the whole previewed set without another confirmation or acknowledgement
