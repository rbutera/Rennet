## ADDED Requirements

### Requirement: A light-tier digest rephrases the delta account, adding no new fact
The system SHALL produce, from a `Review.deltaAccount`, a short plain-English digest (one to two sentences) via the light-tier `delta-rereview-summary` seat. The digest SHALL be built from ONLY the structured account (each ask's path, status, and summary, and the beyond-asks paths) — never from repo or diff content — so it is a rephrasing that cannot introduce a fact the deterministic account does not carry.

#### Scenario: The digest names what the account states
- **WHEN** a delta digest is produced for an account of two addressed asks, one untouched ask, and one beyond-asks path
- **THEN** the digest is derived from those facts and its prompt input carries only the account's paths/statuses, not any diff or repo text

### Requirement: The digest is model-free-floored — absent, never fabricated
When the `delta-rereview-summary` seat is unavailable (resolves deterministically, throws, returns empty, or the invocation budget refuses the turn), the system SHALL answer an honest `unavailable` and SHALL NOT surface any digest. The deterministic delta account SHALL render in full regardless of the digest's presence.

#### Scenario: The account renders with the seat stubbed to throw
- **WHEN** the delta digest is requested while the seat is stubbed to throw
- **THEN** the command answers `unavailable`, the delta-account panel renders every fact with no digest headline, and no error propagates to the reviewer

#### Scenario: A budget refusal yields no digest
- **WHEN** the invocation budget refuses the digest turn
- **THEN** the result is `unavailable` and no fabricated digest is returned

### Requirement: The digest renders on top of the facts and gates nothing
The renderer SHALL render the deterministic delta account immediately and request the digest once per (review, delta account); when a digest is returned it SHALL render as a headline ABOVE the account's facts, and when absent the facts SHALL render unchanged with no headline. The digest SHALL never block or gate re-review or sign, and SHALL require no acknowledgement.

#### Scenario: Facts first, digest on top when present
- **WHEN** a successor review carries a delta account
- **THEN** the facts render immediately, the digest is requested once, and a returned digest appears above the facts

#### Scenario: The digest gates nothing
- **WHEN** the digest is present or absent on the successor review
- **THEN** re-review and sign proceed without acknowledging or dismissing it
