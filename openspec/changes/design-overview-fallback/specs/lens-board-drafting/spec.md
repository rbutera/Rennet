## MODIFIED Requirements

### Requirement: The Design lens drafts from the spec it finds, or an overview from what the branch says, or settles absent

The Design seat SHALL receive no discovered artifact bundle. Its instructions SHALL tell it to find the specification for the reviewed branch in the bound workspace if one exists — an OpenSpec change, a BMAD, Kiro, grill-me or superpowers document, an ADR — using the reviewed range's commit messages and the pull request body as the clue, and to draft the Design board from what it finds.

When it finds none, the seat SHALL draft a design overview from three sources in this order: the reviewed pull request's title and description as the host wrote them to `pr.md`; documentation files the branch adds or modifies, read at the reviewed tree; and the related issues the host wrote to `related-context.md`. The overview SHALL carry the stats `Format: Overview` and `Specification: none found`, an intro whose first sentence names the sources it was drafted from, one source-linked section per source file, a `decision` only for a decision a source states with `inferred: false` and its exact source, and a `requirement` only for an acceptance criterion a tracker item states, with the item as its source. The overview SHALL carry no capability, requirement or task counts, and SHALL infer nothing from code.

When all three sources are empty, the lane SHALL settle as an absence with the reason that no spec was found for this branch, and the seat's note SHALL name the three sources it looked for; the bench reader SHALL state that reason, and the finished board views SHALL carry no Design tab. An empty or invented Design board SHALL NOT be drafted, and the overview SHALL NOT be drafted while a specification for the branch exists.

#### Scenario: Design finds the spec on an OpenSpec branch
- **WHEN** the reviewed branch's commits name an OpenSpec change directory that exists in the checkout
- **THEN** the Design board is drafted from that change's artifacts and cites them by path

#### Scenario: Design drafts an overview from the PR description and an issue
- **WHEN** the branch carries no specification, its pull request has a description, and the host's dossier holds one issue with acceptance criteria
- **THEN** the Design board is an overview whose stats read `Format: Overview` and `Specification: none found`, whose intro opens by naming the PR description and the related issue as its sources, with one section per source and one requirement per acceptance criterion carrying the issue id as its source label

#### Scenario: Design drafts an overview from documentation alone
- **WHEN** the branch carries no specification and no pull request, and adds one page under `docs/`
- **THEN** the Design board is an overview with a Documentation section for that page, sourced to its repo-relative path, and no Related issues section

#### Scenario: Design settles absent on a branch with nothing to say
- **WHEN** the branch carries no specification, no pull request paper, no documentation change, and no related issue
- **THEN** the Design lane settles absent with "no spec found for this branch", the seat's note names the three sources it looked for, the bench reader says so, and the board views show no Design tab

#### Scenario: A located specification is never replaced by an overview
- **WHEN** the host located a specification and the seat renders it
- **THEN** no overview is drafted and no related-issue file is awaited
