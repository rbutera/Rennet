# t3code-vendoring Specification

## Purpose
A snapshot of T3 Code's inner layers lives inside the Rennet monorepo with a recorded upstream base and a repeatable way to inspect and fold upstream changes, so Rennet reuses their code without forking their repository.
## Requirements
### Requirement: The vendored snapshot records its upstream base and licence

The vendored tree SHALL carry a machine-readable record of the upstream repository, the exact upstream commit it was taken from, the date it was taken, and the list of vendored paths. The upstream licence file and copyright notices SHALL be present unchanged. Vendored files SHALL keep upstream formatting and SHALL be excluded from Rennet's formatter and linter.

#### Scenario: base is answerable without git archaeology
- **WHEN** a developer opens the vendored tree
- **THEN** one file names the upstream commit, date and path list, and the upstream licence sits beside it

#### Scenario: formatter leaves vendored code alone
- **WHEN** the repository format check runs
- **THEN** no vendored file is reported or rewritten

### Requirement: A pristine vendor branch carries upstream history

A dedicated branch SHALL contain only the vendored paths, assembled from the recorded upstream commit with no local edits. Advancing the snapshot SHALL add one commit to that branch per upstream commit folded, so the main branch merges upstream changes with a three-way merge and conflicts appear only in files Rennet edited.

#### Scenario: clean fold of untouched files
- **WHEN** upstream changes a vendored file Rennet has not edited and the fold runs
- **THEN** the file updates with no conflict

#### Scenario: conflict only where edited
- **WHEN** upstream changes a vendored file listed in the patch ledger and the fold runs
- **THEN** the merge stops on that file with conflict markers and the ledger entry printed beside it

### Requirement: Inspect produces a dated digest of upstream changes

An inspect command SHALL fetch upstream, list the commits between the recorded base and the upstream default branch that touch vendored paths, group them by vendored area, mark commits that touch a file in the patch ledger as conflict risk, and write the digest to a dated file in the vendored tree. It SHALL change nothing else.

#### Scenario: digest names the risk
- **WHEN** upstream has commits touching one patched file and three unpatched files since the base
- **THEN** the digest lists all four with the patched one marked as conflict risk, and the working tree is otherwise unchanged

### Requirement: Fold advances the snapshot to a chosen upstream commit

A fold command SHALL take an upstream commit, advance the vendor branch to it, merge that branch into the current branch, update the recorded base on success, and stop with the patch ledger shown when conflicts remain. A fold SHALL be reviewed as a pull request whose description carries the digest for that range.

#### Scenario: fold updates the base
- **WHEN** a fold to a newer upstream commit merges without conflict
- **THEN** the recorded base equals that commit and the vendor branch tip matches it

### Requirement: Every local edit to a vendored file is in the patch ledger

The patch ledger SHALL list each vendored file Rennet has modified, with the reason, whether the change is upstreamable, and the upstream pull request link once one exists. A repository check SHALL fail when a vendored file differs from the vendor branch and has no ledger entry. Edits that upstream merges SHALL be removed from the ledger at the fold that brings them in.

#### Scenario: unlogged edit is caught
- **WHEN** a vendored file is modified with no ledger entry and the check runs
- **THEN** the check fails naming the file

#### Scenario: upstreamed edit leaves the ledger
- **WHEN** a fold brings in the upstream version of a ledgered change
- **THEN** the fold PR removes that ledger entry

