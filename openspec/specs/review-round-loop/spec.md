# Review round loop specification

## Purpose

State the round model as it was always intended: an unbounded review loop — review, dispatch a coding round, re-review the successor — that the reviewer exits by submitting the pull request when nothing is left to change. A round count is never a terminator.
## Requirements
### Requirement: Round dispatch is available for every dispatchable review, at any depth

Whenever a session holds a dispatchable review — the reviewer's own current-branch review with at least one staged round ask — the reviewer SHALL be able to dispatch a coding round. A round SHALL consist of exactly four steps: resolve the session's bound workspace, run the work order as one turn there, observe the commits that turn left on the session's branch, and regenerate the boards from the successor patchset captured from that workspace. Dispatch SHALL be available again on the successor under the same preconditions. Teammate and retrospective reviews correctly refuse dispatch; an exhausted ask queue correctly offers none. Beyond those preconditions, no component — server dispatch, prompts, client state, or UI copy — SHALL impose or imply a maximum round count.

#### Scenario: Third round behaves like the first

- **WHEN** a session has already landed two coding rounds and the reviewer stages an ask and dispatches a third
- **THEN** the third round runs in the same bound workspace, commits on the same branch, advances the review, and regenerates boards identically to the first, and dispatch is offered again afterward

#### Scenario: Arbitrary depth holds by construction

- **WHEN** the round state machine is driven through N dispatch/land cycles for arbitrary N
- **THEN** every cycle's transitions are identical, with no ordinal-dependent branch and no per-round workspace

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

### Requirement: The worker runs the repository's check; Rennet never does

Rennet SHALL NOT execute the repository's configured check command on the reviewer's behalf as part of a round. A round SHALL have no gate step, no gate phase, no gate receipt and no gate failure. When the project scout has discovered a check command for the repository, the round's work order SHALL instruct the worker to run that command before committing, to commit only when it passes, and to state in its final message why it could not when it fails. When no check command is known, the work order SHALL carry no such instruction rather than an empty or templated one.

#### Scenario: A round with a known check command

- **WHEN** a round is dispatched for a repository whose scout discovered a check command
- **THEN** the work order names that exact command as the worker's own step, and Rennet runs no process of its own between the turn and the commit observation

#### Scenario: A round with no known check command

- **WHEN** a round is dispatched for a repository with no discovered check command
- **THEN** the work order carries no check instruction, and the round still runs, commits and regenerates

#### Scenario: A failing check is the worker's to report

- **WHEN** the worker runs the check and it fails
- **THEN** the worker either fixes it and commits, or leaves the files uncommitted and says why in its final message, and the round settles on that evidence rather than on an exit code Rennet collected

### Requirement: A committing round's receipt names the files it committed

A round's worker receipt SHALL report the files the round actually changed. When the sidecar checkpoint's working-tree diff is empty because the worker committed its work, and the bound workspace's commit range for this round is non-empty, the receipt's diff and changed paths SHALL be derived from that commit range. A turn that edited without committing SHALL keep the checkpoint's working-tree diff and SHALL still fail with the reason that nothing was committed.

#### Scenario: The worker commits and the checkpoint is clean

- **WHEN** a round's turn commits its work, leaving the working tree clean and the checkpoint diff empty
- **THEN** the receipt names the committed files and the round completes, never reporting "changed 0 files" or a disagreement between the worker and the commit range

#### Scenario: The worker edits without committing

- **WHEN** a round's turn leaves changes in the working tree and commits nothing
- **THEN** the receipt carries the working-tree diff and the round fails, naming that the turn edited without committing

