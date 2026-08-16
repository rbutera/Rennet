## MODIFIED Requirements

### Requirement: Only chunk-assignable angles may be declared on a chunk (V104)
A chunk SHALL declare angles only from the closed set `sequence`, `decisions`, `blast-radius`. A chunk that declares `noise`, `spec`, `claims`, or any value outside the set, SHALL reject with code V104 — verified noise is deterministic-only, spec is a queue over requirements rather than chunk membership, and the claims angle is retired (issue #221; the Decisions lens owns that ground).

#### Scenario: A chunk assigned to noise rejects
- **WHEN** a chunk declares the angle `noise`
- **THEN** validation rejects with V104

#### Scenario: A chunk assigned to spec rejects
- **WHEN** a chunk declares the angle `spec`
- **THEN** validation rejects with V104

#### Scenario: A chunk assigned to claims rejects
- **WHEN** a chunk declares the retired angle `claims`
- **THEN** validation rejects with V104
