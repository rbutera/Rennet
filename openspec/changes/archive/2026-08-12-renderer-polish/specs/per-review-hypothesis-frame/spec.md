# per-review-hypothesis-frame

Session-scoped hypothesis-frame collapse state owned by the review whose reading frame it controls.

## ADDED Requirements

### Requirement: Hypothesis collapse state is keyed per review

The renderer SHALL thread the active `reviewId` into the mounted canvas workspace and SHALL store the hypothesis reading frame's expanded or collapsed state under that review id. A review with no stored choice SHALL render expanded. Changing the active patchset without changing the review id SHALL preserve the choice.

#### Scenario: collapse does not leak into another review

- **WHEN** the reviewer collapses the hypothesis frame on review A
- **AND** the same mounted workspace changes to previously unseen review B
- **THEN** review B's hypothesis frame is expanded

#### Scenario: returning to a review restores its choice

- **WHEN** review A's hypothesis frame was collapsed
- **AND** the workspace moves to review B and later returns to review A
- **THEN** review A's hypothesis frame is collapsed

#### Scenario: regeneration preserves the review choice

- **WHEN** a new active patchset is rendered under the same review id
- **THEN** the hypothesis frame keeps that review's existing expanded or collapsed state

