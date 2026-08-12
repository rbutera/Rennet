## ADDED Requirements

### Requirement: The delta account is computed deterministically with no model call
The system SHALL compute the full delta account — every ask's addressed/partial/untouched status and the complete beyond-asks set — from the shipped lineage carry (`carried`/`orphaned`) and the disposition-id trace alone, with no model invocation. The Model Council M25 light seat MAY rephrase the structured account into prose, but the structured account SHALL be complete and correct when that seat is absent, throwing, or over budget.

#### Scenario: The account renders with the light seat unavailable
- **WHEN** the delta account is built for a returned patchset while the M25 light seat is stubbed to throw
- **THEN** the structured account still lists every ask's status and every beyond-asks hunk, and no error propagates to the reviewer

#### Scenario: Prose is garnish, not substance
- **WHEN** the M25 seat produces prose over the structured account
- **THEN** the prose adds no fact absent from the deterministic skeleton, and removing the prose leaves the account's facts unchanged

### Requirement: Each ask is classified addressed, partially addressed, or untouched
For every staged disposition in the handoff bundle, the system SHALL classify the returned patchset's effect on that ask's target as addressed (the target's bytes changed), partially addressed (a multi-target ask where some targets changed and some carried unchanged), or untouched (the target carried byte-identically), using the disposition-id trace and the lineage carry.

#### Scenario: Two addressed, one untouched
- **WHEN** a bundle of three asks returns a patchset that changes the targets of two asks and leaves the third's target byte-identical
- **THEN** the account marks the first two addressed and the third untouched

### Requirement: Changes beyond the asks are detected and surfaced loudly
The system SHALL identify every hunk in the returned patchset that traces to no staged disposition and is net-new (not a carried prior hunk), and surface these as "beyond your asks". The partition SHALL be total: every returned-patchset hunk is exactly one of addressed-an-ask, beyond-asks, or a carried-unchanged prior hunk, with none unaccounted.

#### Scenario: An unrequested change is flagged beyond-asks
- **WHEN** the returned patchset contains a hunk that traces to no staged disposition id
- **THEN** that hunk appears in the beyond-asks set and is rendered prominently

#### Scenario: Reverting beyond-asks detection reddens the fixture
- **WHEN** the beyond-asks detection is reverted and the three-ask fixture (2 addressed, 1 ignored, 1 unrequested) runs
- **THEN** the unrequested change is not flagged and the test reddens

### Requirement: The account renders at the top of the successor canvas and anchors to hunks
The system SHALL render the delta account at the top of the successor canvas (journey stage 7) as the entry to delta re-review, and each account item SHALL anchor so that activating it scrolls the diff to the moved hunk(s). The account SHALL never block or gate re-review or sign.

#### Scenario: Tapping an item navigates to its hunk
- **WHEN** the reviewer activates a "what moved" item in the account
- **THEN** the diff scrolls to the corresponding hunk(s) and pulses them

#### Scenario: The account gates nothing
- **WHEN** the account is present on the successor canvas
- **THEN** re-review and sign proceed without acknowledging or dismissing it
