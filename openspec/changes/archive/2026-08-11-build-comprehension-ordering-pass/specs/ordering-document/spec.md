## ADDED Requirements

### Requirement: The `ordering` document type exists and is validated atomically
The RSP protocol SHALL define an `ordering` document type whose body is `{ readingOrder: string[]; rationale: string }`. It SHALL be registered as atomic (any body error rejects the whole document) with supported schema version 1, and `bodyJsonSchema("ordering")` SHALL project an object JSON schema for the structured-output constraint.

#### Scenario: A well-formed ordering document is admitted
- **WHEN** an `ordering` document whose `readingOrder` lists every offered chunk exactly once and whose `rationale` is non-empty is validated
- **THEN** it is admitted with no errors

#### Scenario: A mis-shaped ordering body rejects
- **WHEN** an `ordering` body is missing `readingOrder` or `rationale`, or has the wrong type for one
- **THEN** validation rejects with code V108

### Requirement: Ordering totality is a cover of the offered chunk set (V111)
An `ordering` document SHALL list every offered chunk id exactly once in `readingOrder`. A chunk offered by the decomposition but absent from the order, or a chunk listed more than once, SHALL reject with code V111.

#### Scenario: A missing chunk rejects
- **WHEN** the decomposition offers chunks `c1`, `c2` and the order lists only `c1`
- **THEN** validation rejects with V111

#### Scenario: A duplicated chunk rejects
- **WHEN** the order lists the same chunk id twice
- **THEN** validation rejects with V111

### Requirement: Ordering references no minted chunk identity (V112)
Every id in an `ordering` document's `readingOrder` SHALL be a chunk id offered by the admitted decomposition. An id absent from the offered chunk set (a fabricated or minted identity) SHALL reject with code V112.

#### Scenario: A fabricated chunk id rejects
- **WHEN** the order lists `c1`, `c2`, and `c9` while only `c1` and `c2` were offered
- **THEN** validation rejects with V112

### Requirement: Ordering carries a required rationale (V113)
An `ordering` document SHALL carry a non-empty `rationale`. An empty or whitespace-only rationale SHALL reject with code V113.

#### Scenario: An empty rationale rejects
- **WHEN** an otherwise valid ordering document has a whitespace-only rationale
- **THEN** validation rejects with V113
