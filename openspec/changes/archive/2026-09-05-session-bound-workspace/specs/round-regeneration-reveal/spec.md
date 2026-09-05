## MODIFIED Requirements

### Requirement: Cross-lens coverage is honest without becoming a reveal barrier

Coverage SHALL be a projection the daemon derives from the boards' citations against the captured patchset, never a gate. No lane SHALL be held, failed or annotated because regions of the change are uncited, and no seat SHALL be asked to account for regions it did not cite. When the surface shows coverage it SHALL show it as the proportion and the list of changed regions the settled boards cite, updated as boards settle; withholding settled boards is not an acceptable way to represent pending coverage.

#### Scenario: Boards reveal regardless of coverage
- **WHEN** core boards have settled and together cite half of the changed regions
- **THEN** every settled board is revealed and the coverage view, if shown, lists the uncited regions as uncited

#### Scenario: An absent Design lane is a settled state
- **WHEN** the Design lane settles absent because no spec was found
- **THEN** the reveal treats the generation as settled once the other lanes settle, the bench reader states the reason, and the finished board views carry no Design tab

#### Scenario: Coverage pending after core reveal

- **WHEN** core boards are revealed and cross-lens coverage has not completed
- **THEN** the surface states that coverage is pending rather than hiding the boards or claiming coverage
