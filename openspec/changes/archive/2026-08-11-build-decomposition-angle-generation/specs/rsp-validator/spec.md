## ADDED Requirements

### Requirement: Decomposition documents are validated against per-body schemas and rules
The validator SHALL dispatch, after the envelope and generic anchor/quote checks, to a per-docType body validator for `decomposition.skeleton` and `decomposition.proposal`. Both are atomic, so any body error rejects the whole document. The generic anchor, quote, vocabulary, and identity guarantees SHALL be unchanged.

#### Scenario: A well-formed decomposition proposal is admitted
- **WHEN** a `decomposition.proposal` whose chunks partition the offered hunks, whose edges are acyclic, and whose reading order covers every chunk is validated
- **THEN** it is admitted with no errors

### Requirement: Totality is enforced as an exact partition of the offered hunks (V100)
A decomposition document SHALL place every offered hunk exactly once across its chunks and residue: the multiset of chunk hunk ids plus residue hunk ids SHALL equal the set of offered `hunk` occurrences, with no missing hunk, no hunk absent from the offered manifest, and no hunk placed in two chunks. Any violation SHALL reject with code V100.

#### Scenario: A missing hunk rejects
- **WHEN** a proposal omits one offered hunk from every chunk and from residue
- **THEN** validation rejects with V100

#### Scenario: A minted hunk rejects
- **WHEN** a chunk references a hunk id absent from the offered manifest
- **THEN** validation rejects with V100

#### Scenario: A doubly-placed hunk rejects
- **WHEN** the same hunk id appears in two chunks
- **THEN** validation rejects with V100

### Requirement: The reading order is an acyclic topological cover (V103)
For `decomposition.proposal`, `edges` SHALL form a directed acyclic graph and `readingOrder` SHALL be a permutation of the declared chunk ids that covers each exactly once and lists the source of every edge before its target. A cycle, a gap, or an order that violates an edge SHALL reject with code V103.

#### Scenario: A cyclic edge set rejects
- **WHEN** the edges contain a cycle
- **THEN** validation rejects with V103

#### Scenario: A reading order that misses a chunk rejects
- **WHEN** `readingOrder` omits a declared chunk
- **THEN** validation rejects with V103

### Requirement: Only chunk-assignable angles may be declared on a chunk (V104)
A chunk SHALL declare angles only from the closed set `sequence`, `decisions`, `claims`, `blast-radius`. A chunk that declares `noise` or `spec`, or any value outside the set, SHALL reject with code V104, because verified noise is deterministic-only and spec is a queue over requirements, not chunk membership.

#### Scenario: A chunk assigned to noise rejects
- **WHEN** a chunk declares the angle `noise`
- **THEN** validation rejects with V104

#### Scenario: A chunk assigned to spec rejects
- **WHEN** a chunk declares the angle `spec`
- **THEN** validation rejects with V104

### Requirement: The chunk graph is referentially complete (V106)
Chunk ids SHALL be unique within a document, and every chunk id referenced by an edge or by the reading order SHALL name a declared chunk. A duplicate chunk id or a dangling reference SHALL reject with code V106.

#### Scenario: A dangling edge endpoint rejects
- **WHEN** an edge references a chunk id that no chunk declares
- **THEN** validation rejects with V106
