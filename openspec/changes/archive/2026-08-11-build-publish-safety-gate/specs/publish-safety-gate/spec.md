## ADDED Requirements

### Requirement: A completed sign emits exactly the previewed bytes
When the publish sheet completes a sign, it SHALL invoke its sign callback with a payload that is BYTE-EQUAL to `stagedPayload(batch)` — the same bytes it previews — never a transform of them. This SHALL be verified by observing the callback argument in a mounted DOM, not by an SSR presence check.

#### Scenario: A sufficient hold emits the previewed bytes verbatim
- **WHEN** the sheet is mounted and a hold meeting `holdToSignMs` is completed
- **THEN** the sign callback is called exactly once with a string byte-equal to `stagedPayload(batch)`

#### Scenario: The emit observation can fail
- **WHEN** the emitted payload is altered to differ from the preview by any byte
- **THEN** the emit-fidelity test fails

### Requirement: A hold below the budget never signs
The publish sheet SHALL NOT invoke its sign callback for a pointer hold whose elapsed duration is below `holdToSignMs`. A hold meeting or exceeding `holdToSignMs` (floor 0 permitting an immediate sign) SHALL invoke it. This wiring SHALL be verified at the mounted component boundary, not only in the pure `resolveSign` predicate.

#### Scenario: Too-short hold does not sign
- **WHEN** the sheet is mounted and a hold shorter than `holdToSignMs` is released
- **THEN** the sign callback is not called

#### Scenario: Sufficient hold signs
- **WHEN** a hold meeting `holdToSignMs` is released
- **THEN** the sign callback is called

### Requirement: A keyboard user can complete the publish act deliberately
The publish sheet SHALL let a keyboard/AT user complete the publish act via an explicit Enter or Space activation of the focused sign control, at the default non-zero hold budget, without weakening the no-passive-approval property (nothing signs without an intentional key activation of the focused control). The keyboard sign SHALL emit exactly the previewed bytes and SHALL be subject to the same degradation-ledger gate as the pointer path.

#### Scenario: Enter on the focused control signs with the previewed bytes
- **WHEN** the sign control is focused and Enter is pressed under the default non-zero hold
- **THEN** the sign callback is called with a payload byte-equal to `stagedPayload(batch)`

#### Scenario: Keyboard sign respects the ledger gate
- **WHEN** the ledger carries an unacknowledged entry and Enter is pressed on the focused sign control
- **THEN** the sign callback is not called


### Requirement: Signing clears the staged paper at the app level
When a sign completes in `RennetApp`, the staged set SHALL be cleared to empty and the publish sheet SHALL close, demonstrating the dispose==staged journey ending. This SHALL be verified by mounting `RennetApp` and observing the staged count return to zero, not by exercising a presentational subcomponent alone.

#### Scenario: Signing empties the destination
- **WHEN** `RennetApp` is mounted, a disposition is staged, the sheet is opened, and a sign is completed
- **THEN** the destination's staged count returns to zero and the sheet is closed

### Requirement: A shell sign honestly discloses that nothing was published
While the publish pipeline (#21) is unbuilt, the publish sheet SHALL carry a persistent, aria-legible notice that signing in the shell clears the staged paper and publishes nothing, so a shell sign can never read as a real publish under the paper/glass doctrine.


#### Scenario: The shell honesty notice is present
- **WHEN** the publish sheet renders
- **THEN** a notice stating that the shell publishes nothing (real publishing lands in #21) is present and legible to assistive technology
