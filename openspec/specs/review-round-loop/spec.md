# Review round loop specification

## Purpose

State the round model as it was always intended: an unbounded review loop — review, dispatch a coding round, re-review the successor — that the reviewer exits by submitting the pull request when nothing is left to change. A round count is never a terminator.

## Requirements

### Requirement: Round dispatch is available for every dispatchable review, at any depth

Whenever a session holds a dispatchable review — the reviewer's own current-branch review with at least one staged round ask — the reviewer SHALL be able to dispatch a coding round. After a round lands and its boards regenerate, dispatch SHALL be available again on the successor review under the same preconditions. Teammate and retrospective reviews correctly refuse dispatch; an exhausted ask queue correctly offers none. Beyond those preconditions, no component — server dispatch, prompts, client state, or UI copy — SHALL impose or imply a maximum round count.

#### Scenario: Third round behaves like the first

- **WHEN** a session has already landed two coding rounds and the reviewer stages an ask and dispatches a third
- **THEN** the third round dispatches, executes, lands, and regenerates boards identically to the first, and dispatch is offered again afterward

#### Scenario: Arbitrary depth holds by construction

- **WHEN** the round state machine is driven through N dispatch/land cycles for arbitrary N
- **THEN** every cycle's transitions are identical, with no ordinal-dependent branch

#### Scenario: Positive control introduces an ordinal assumption

- **WHEN** a control caps or special-cases dispatch by round ordinal
- **THEN** the N-round loop proof fails

### Requirement: The submitted pull request terminates the loop, not a count and not a draft

The loop's terminal state SHALL be the reviewer's decision that no further changes are needed, expressed through the pull-request submit/open action. Composing or holding a PR draft SHALL NOT terminate the loop — rounds remain dispatchable while a draft exists. The exit SHALL be available at every point the review is publishable — including after zero rounds — and SHALL never be gated on having run any particular number of rounds.

#### Scenario: Reviewer submits with zero rounds

- **WHEN** a reviewer inspects a review and has no changes to request
- **THEN** the submit exit is available immediately, with no round required

#### Scenario: Draft in hand, another round needed

- **WHEN** a reviewer has composed a PR draft and then spots one more change to request
- **THEN** they can stage the ask and dispatch another round without discarding loop continuity

#### Scenario: Reviewer submits after many rounds

- **WHEN** a reviewer lands their Nth round and the successor boards satisfy them
- **THEN** the same submit exit closes the loop on the successor patchset

### Requirement: Round history stays legible at any depth

The rounds ledger and session continuity surfaces SHALL present N rounds legibly — ordering, per-round accounts, and delta continuity SHALL NOT degrade or truncate silently as rounds accumulate.

#### Scenario: Ledger shows a long-running session

- **WHEN** a session accumulates five or more landed rounds
- **THEN** the ledger presents every round's account in order with its report and continuity intact
