## MODIFIED Requirements

### Requirement: The daemon resolves citations against the patchset

The daemon SHALL resolve every citation against the captured patchset AT THE MOMENT THE CITATION IS MADE. A citation whose range falls inside a changed region of the named path on the named side SHALL resolve to that region and yield a citable reference; a citation that does not SHALL be refused in the same turn, with the nearest changed range on that path and side, or with the fact that the path has no changed lines on that side at all.

A board SHALL therefore never come to hold an unresolvable citation. The rule that reports one SHALL remain, as the guard on any path that writes a citation without going through the citing call.

#### Scenario: Citation outside the change

- **WHEN** a seat cites a range that no changed region of the patchset covers
- **THEN** the call is refused with the path, the range and the nearest changed range, and no reference is created

#### Scenario: Citation inside the change

- **WHEN** a seat cites a range inside a changed region
- **THEN** the citation resolves, the seat receives a reference it can attach to an element, and the surface anchors it to those lines

#### Scenario: Positive control writes a citation past the boundary

- **WHEN** a control writes an out-of-change citation onto a board without going through the citing call
- **THEN** the unresolvable-citation rule reports it
