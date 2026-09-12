## ADDED Requirements

### Requirement: Related issues reach the Design seat as a bounded context file

When the Design seat will run without a host-located specification, the host SHALL write `related-context.md` under the session's context directory from the dossier that related-context retrieval stored for the review target and patchset: one region per item in dossier order with its id, tracker, title, state, URL, provenance, bounded body, and acceptance criteria when present. The file SHALL declare its bounds at the call site and end on a line naming the dropped count when a bound is hit; it SHALL NOT be written when there are no items. It SHALL be named in the Design seat's prompt alone. The Design lane SHALL wait for retrieval up to a declared ceiling; past the ceiling the file SHALL carry the deterministically extracted refs with their URLs and a line saying retrieval had not finished. The host-located and assembler paths SHALL NOT wait.

#### Scenario: The dossier is on disk before the Design seat opens
- **WHEN** retrieval settles within the ceiling on a branch with no located specification
- **THEN** `related-context.md` lists every dossier item and the Design prompt names it; no other seat's prompt does

#### Scenario: Retrieval outlasts the ceiling
- **WHEN** the tracker endpoint has not answered when the ceiling passes
- **THEN** the Design seat opens with a `related-context.md` that lists the extracted refs and their URLs and says retrieval had not finished, and the lane's latest event said it was waiting for related issues

#### Scenario: A branch with no refs writes no file
- **WHEN** the branch name, commit messages, PR title and body carry no issue or tracker reference and the dossier is empty
- **THEN** no `related-context.md` is written and the Design prompt does not name one
