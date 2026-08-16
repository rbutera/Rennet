# handoff-bundle-composition Specification (delta)

## MODIFIED Requirements

### Requirement: The traceMap maps every ask id to its task index exactly once

`ComposedHandoffBundle.traceMap` SHALL map every input ask id to the index of the task it landed in, with every id present exactly once. This is the forward hook issue #73 consumes for delta re-review map-back — and it is now consumed: when `review.handoff.run` captures the successor patchset, it SHALL hand the verified bundle's ask trace (the id-stamped asks with their anchors, the `traceMap`, and each task's preview title) to the capture, so the successor's delta account can attribute each staged ask to the composed task that carried it. The trace is attached only by the handoff run — a capture from any other path carries none — and it is narration for the account, never a gate on the capture.

#### Scenario: every id is traced to exactly one task index

- **WHEN** a composed bundle (floor or authored) is assembled
- **THEN** `traceMap` has an entry for every ask id, each pointing at its task's index, with no id missing or duplicated

#### Scenario: the run hands the ask trace to the successor capture

- **WHEN** a handoff run of a verified composed bundle completes and captures the successor patchset
- **THEN** the capture receives the bundle's ask trace, and the successor review's delta account attributes its asks through the traceMap
