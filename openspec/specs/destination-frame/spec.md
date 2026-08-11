# destination-frame Specification

## Purpose
TBD - created by archiving change build-destination-frame. Update Purpose after archive.
## Requirements
### Requirement: The destination is persistent and present from review-open, even with nothing staged
The UI SHALL render a persistent destination target from the moment a review is open, before any disposition is made. With an empty staged set the destination SHALL be present and legible (an empty forming paper), never hidden or absent. It SHALL be always-present chrome, shown regardless of which workspace view (Files or Canvases) is active.

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
The destination SHALL frame the same staged set two ways by mode: `own-branch` presents the handoff / PR-submission bundle being built; `other-pr` presents the review that will be posted. The staged data SHALL be identical across variants; only the framing (title, summary, sign label) changes with mode.

#### Scenario: Mode switches the variant over the same staged data
- **WHEN** the same staged set is rendered as `own-branch` and then as `other-pr`
- **THEN** the two renders show distinct framing (handoff bundle vs review to post) while the staged item set is identical

### Requirement: The publish sheet previews exactly what will leave the machine and gates on hold-to-confirm
The publish sheet SHALL list the staged items as exactly the outbound artifact, with the previewed bytes equal to the staged payload bytes. Signing SHALL be gated by a hold-to-confirm affordance (`holdToSignMs`, accessibility floor 0) and SHALL never default to APPROVE. For v1 the signing act SHALL be all-or-nothing over the whole staged set; publishing a subset requires withdrawing first, then signing. This slice SHALL perform no Git or GitHub mutation.

#### Scenario: Preview bytes equal the staged payload bytes
- **WHEN** the publish sheet previews a staged set and the staged payload is serialised
- **THEN** the two byte sequences are equal

#### Scenario: Hold-to-confirm gates the publish act
- **WHEN** the elapsed hold is below `holdToSignMs`
- **THEN** signing is not permitted; and **WHEN** the elapsed hold meets `holdToSignMs` (floor 0 permitting an immediate sign) the publish act is allowed

