## Purpose

A citation is a path and a line range, the way every reviewer writes one. The daemon resolves it against the captured patchset; no hunk identifier reaches a model or is expected back from one.

## ADDED Requirements

### Requirement: A citation is a path and a line range

Every code citation a lens board carries SHALL be a repository path plus a 1-based inclusive line range on the new side or the old side of the change. A drafting prompt SHALL NOT offer hunk identifiers, and a board SHALL NOT be required to return any. The seat SHALL read the change itself with its own tools to decide what to cite.

#### Scenario: A finding cites changed lines
- **WHEN** a seat drafts a finding about lines 41 to 58 of a changed file
- **THEN** the citation carries the path, the side and that range, and nothing else identifies the hunk

### Requirement: The daemon resolves citations against the patchset

The daemon SHALL resolve every citation against the captured patchset. A citation whose range falls inside a changed region of the named path on the named side SHALL resolve to that region; a citation that does not SHALL be a lint violation carried back to the seat as a pointer, exactly as any other structural violation is.

#### Scenario: Citation outside the change
- **WHEN** a board cites a range that no changed region of the patchset covers
- **THEN** lint reports the citation as unresolvable with the path and range, and the repair turn carries that pointer

#### Scenario: Citation inside the change
- **WHEN** a board cites a range inside a changed region
- **THEN** the citation resolves and the surface anchors it to those lines

### Requirement: Coverage is a projection, never a seat contract

The daemon MAY project which changed regions the boards cite, for a coverage view. No lens SHALL be required to account for regions it did not cite, no skip list SHALL be part of a board, and no composition step SHALL block, fail or annotate a reveal on coverage.

#### Scenario: Uncited regions do not fail a generation
- **WHEN** the five boards together cite half of the changed regions
- **THEN** the generation settles normally and any coverage view shows the uncited regions as uncited

### Requirement: Delta marks key on path and range

The marks that distinguish a regenerated board's elements from the previous generation's SHALL key on the cited path and range, never on a hunk identifier.

#### Scenario: Regeneration keeps a stable mark
- **WHEN** a board is regenerated after a round and an element still cites the same path and range
- **THEN** the element carries the same delta mark it would have carried under the previous keying
