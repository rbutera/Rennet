## ADDED Requirements

### Requirement: The primary base is the newest ref naming the primary branch

Every local surface that measures a branch or a working tree against the primary branch SHALL resolve the primary base through one resolver. Given a repository and the primary branch's name, the resolver SHALL consider every ref in the clone that names that branch: the remote-tracking ref for each remote, `origin` first, then the local branch. It SHALL drop a candidate that does not resolve to a commit. It SHALL choose the newest surviving candidate, the one no other candidate is ahead of. Where two candidates have each moved past the other, the remote-tracking one SHALL win, and among remote-tracking refs the earlier in the remote order SHALL win. The resolver SHALL read refs and SHALL NOT write one, fetch, or reach the network.

#### Scenario: Local primary is behind the remote-tracking ref
- **WHEN** local `main` is at commit X, `origin/main` is at commit Y which descends from X, and a branch was cut from Y
- **THEN** the resolver chooses `origin/main`, and the branch's base is Y

#### Scenario: Local primary is ahead of the remote-tracking ref
- **WHEN** `origin/main` is at commit X, local `main` is at commit Y which descends from X, and a branch was cut from Y
- **THEN** the resolver chooses `main`, and the branch's base is Y

#### Scenario: The two spellings have diverged
- **WHEN** local `main` and `origin/main` each carry a commit the other lacks
- **THEN** the resolver chooses `origin/main`

#### Scenario: Only one spelling exists
- **WHEN** the repository has no remote and a local `main`
- **THEN** the resolver chooses `main`

#### Scenario: No spelling exists
- **WHEN** no ref in the clone names the primary branch
- **THEN** the resolver reports no primary ref, and the caller's own fallback applies

### Requirement: The base commit is the merge-base with the reviewed head

Where a caller supplies a head, the resolver SHALL report the base commit as the merge-base of the chosen ref and that head, so that a branch that already contains the primary branch's newest commits has a base at the point it left the primary branch, never at an older tip.

#### Scenario: Branch cut from a fresher primary than the local one knows
- **WHEN** local `main` is at X, `origin/main` is at Y descending from X, and the reviewed head descends from Y
- **THEN** the base commit is Y, and the range Y...head carries only the branch's own commits

#### Scenario: Branch that has not merged the newest primary
- **WHEN** the chosen ref is at Y and the reviewed head left the primary branch at an earlier commit X
- **THEN** the base commit is X
