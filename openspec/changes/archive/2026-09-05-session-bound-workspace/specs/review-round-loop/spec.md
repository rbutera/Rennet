## MODIFIED Requirements

### Requirement: Round dispatch is available for every dispatchable review, at any depth

Whenever a session holds a dispatchable review — the reviewer's own current-branch review with at least one staged round ask — the reviewer SHALL be able to dispatch a coding round. The round SHALL run as a turn in the session's bound workspace and its commits SHALL land on the session's branch; the review SHALL then advance to a successor patchset captured from the bound workspace, and dispatch SHALL be available again on the successor under the same preconditions. Teammate and retrospective reviews correctly refuse dispatch; an exhausted ask queue correctly offers none. Beyond those preconditions, no component — server dispatch, prompts, client state, or UI copy — SHALL impose or imply a maximum round count.

#### Scenario: Third round behaves like the first

- **WHEN** a session has already landed two coding rounds and the reviewer stages an ask and dispatches a third
- **THEN** the third round runs in the same bound workspace, commits on the same branch, advances the review, and regenerates boards identically to the first, and dispatch is offered again afterward

#### Scenario: Arbitrary depth holds by construction

- **WHEN** the round state machine is driven through N dispatch/land cycles for arbitrary N
- **THEN** every cycle's transitions are identical, with no ordinal-dependent branch and no per-round workspace

#### Scenario: Positive control introduces an ordinal assumption

- **WHEN** a control caps or special-cases dispatch by round ordinal
- **THEN** the N-round loop proof fails
