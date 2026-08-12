## MODIFIED Requirements

### Requirement: Signing an own-branch review pushes the branch and opens a PR
Previously the own-branch sign path short-circuited to a no-op handoff state. The system SHALL, on a single human sign-click for an own-branch review, push the review's branch and create a real GitHub pull request via the same egress path the `other-pr` destination uses, then return the created PR's URL to the reviewer. There SHALL be no separate egress ceremony, consent token, or acknowledgement step beyond that one sign-click.

#### Scenario: Own-branch sign opens a PR
- **WHEN** the reviewer signs an own-branch review
- **THEN** the branch is pushed, a pull request is created once, and the PR URL surfaces to the reviewer

#### Scenario: A push or create failure is reported honestly
- **WHEN** the push or PR creation fails
- **THEN** the failure surfaces to the reviewer and no success or PR URL is fabricated

#### Scenario: Exactly one push and one PR per click
- **WHEN** the sign action's async push/create is in flight and the component re-renders
- **THEN** the action does not re-enter, and exactly one push and one PR result from the single click

## ADDED Requirements

### Requirement: The pull request head is a branch ref, not a commit SHA
The own-branch PR-submission payload SHALL carry the review's head as a branch ref. A commit SHA (e.g. `headOid.slice(0, 7)`) SHALL NOT be used as the PR `head`. If the branch ref crosses the IPC boundary, it SHALL be present in the `packages/protocol` Zod schema as a field that cannot be silently stripped (required, or type-annotated).

#### Scenario: The submission payload carries a branch ref
- **WHEN** an own-branch PR-submission payload is built
- **THEN** its `head` is the review's branch ref and is never a bare commit SHA

### Requirement: The drafted title and body, including human edits, are what land
The pull request SHALL open with the title and body from the collation draft (#74), including any edits the human made in that draft. The deterministic composed body SHALL be used when no drafter is available.

#### Scenario: Human-edited draft lands on the PR
- **WHEN** the human edits the drafted PR title/body and then signs
- **THEN** the opened PR carries the edited title and body

### Requirement: The other-pr path is unchanged
Wiring own-branch submission SHALL NOT alter the `other-pr` destination (#235). Its payload and behaviour SHALL remain byte-identical to `main`.

#### Scenario: other-pr payload is byte-identical
- **WHEN** an `other-pr` review is signed after this change
- **THEN** its posted payload and behaviour match `main` exactly
