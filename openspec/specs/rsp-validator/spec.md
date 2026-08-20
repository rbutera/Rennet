# rsp-validator specification

## Purpose

The standalone RSP validator checks document schemas, patchset identity, byte-exact evidence, decomposition graphs, provenance, and size limits before admitting model output.

## Requirements

### Requirement: Decomposition documents are validated against per-body schemas and rules
The validator SHALL pass the whole offered manifest to each body validator. Decomposition documents SHALL constrain `hunk` occurrences, and ordering documents SHALL constrain `chunk` occurrences. Generic anchor, quote, vocabulary, and identity checks SHALL apply with decomposition rules V100, V101, V103, V104, V105, V106, and V108.

#### Scenario: A well-formed decomposition proposal is still admitted
- **WHEN** a `decomposition.proposal` whose chunks partition the offered hunks, whose edges are acyclic, and whose reading order covers every chunk is validated
- **THEN** it is admitted with no errors

#### Scenario: The ordering document is validated against the offered chunk set
- **WHEN** an `ordering` document is validated
- **THEN** its totality and no-minted rules are checked against the offered `chunk` occurrences, not the `hunk` occurrences

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
A chunk SHALL declare angles only from the closed set `sequence`, `decisions`, `blast-radius`. A chunk that declares `noise`, `spec`, `claims`, or any value outside the set SHALL reject with code V104. Noise is deterministic, spec coverage runs over requirements, and decisions cover claims about intent and trade-offs.

#### Scenario: A chunk assigned to noise rejects
- **WHEN** a chunk declares the angle `noise`
- **THEN** validation rejects with V104

#### Scenario: A chunk assigned to spec rejects
- **WHEN** a chunk declares the angle `spec`
- **THEN** validation rejects with V104

#### Scenario: A chunk assigned to claims rejects
- **WHEN** a chunk declares the angle `claims`
- **THEN** validation rejects with V104

### Requirement: The chunk graph is referentially complete (V106)
Chunk ids SHALL be unique within a document, and every chunk id referenced by an edge or by the reading order SHALL name a declared chunk. A duplicate chunk id or a dangling reference SHALL reject with code V106.

#### Scenario: A dangling edge endpoint rejects
- **WHEN** an edge references a chunk id that no chunk declares
- **THEN** validation rejects with V106

### Requirement: The validator is a pure, standalone function
The validator SHALL be a pure function of `(document, patchset, offeredManifest, settings)` with no network, model, or clock, and SHALL run standalone against a fixture manifest with zero application context.

#### Scenario: A well-formed document is admitted with only a manifest
- **WHEN** a well-formed document is validated against only a patchset reference and an offered manifest
- **THEN** it is admitted with no errors and a zero rejected count

### Requirement: An unknown docType is rejected loudly
The validator SHALL reject a document whose `docType` is not a known type, and SHALL reject a document whose `rsp` major is unsupported or whose `schemaVersion` falls outside the supported window for its type.

#### Scenario: An unknown docType
- **WHEN** a document declares a `docType` outside the known set
- **THEN** it is rejected with a V001 error naming the unknown type

### Requirement: Agents never mint identity and every quote is byte-matched
The validator SHALL reject any anchor whose occurrence id is absent from the offered manifest, and SHALL reject any evidence quote that does not match its resolved span byte-for-byte after the declared normalisation (CRLF to LF, trailing whitespace stripped, leading indentation preserved).

#### Scenario: A fabricated anchor id
- **WHEN** an anchor references an id present in neither the manifest nor the lineage graph
- **THEN** the document is rejected with a V008 agent-minted-identity error

#### Scenario: A paraphrased quote
- **WHEN** an evidence quote differs from its resolved span by more than trailing whitespace
- **THEN** the document is rejected with a V006 byte-mismatch error

#### Scenario: A quote differing only in trailing whitespace
- **WHEN** an evidence quote differs from its resolved span only in trailing whitespace or line-ending style
- **THEN** the quote matches and the document is admitted

### Requirement: Closed vocabularies and complete provenance are enforced
The validator SHALL reject an anchor whose kind or side is outside its closed vocabulary (V007), SHALL reject a document whose envelope or provenance fails the schema (V002), and SHALL reject a document missing either required capability name or its three layers (V003).

#### Scenario: An out-of-vocabulary anchor kind
- **WHEN** a body anchor uses a kind outside the closed set
- **THEN** the document is rejected with a V007 error

### Requirement: The input digest is recomputed and must match
The validator SHALL recompute the offered manifest's digest and SHALL reject a document whose `inputDigest` does not equal it (V009).

#### Scenario: A mismatched input digest
- **WHEN** a document's `inputDigest` does not equal the recomputed digest of the offered manifest
- **THEN** the document is rejected with a V009 error

### Requirement: Size limits reject and no item count is capped
The validator SHALL reject a document or quote that exceeds its byte limit rather than truncating it (V004), and SHALL NOT impose any item-count cap on any document: there is no `maxItems` in any schema and decisions are never capped.

#### Scenario: An over-size document
- **WHEN** a document's canonical serialisation exceeds the configured byte limit
- **THEN** it is rejected with a V004 error and nothing is truncated

### Requirement: Admission granularity is atomic for graphs and item-wise for collections
The validator SHALL reject a graph document wholesale on any error. It SHALL admit a collection document item by item, drop invalid items, admit valid items, and report the rejected-item count.

#### Scenario: An atomic document with one bad anchor
- **WHEN** a graph document contains a single unresolvable anchor
- **THEN** the whole document is rejected and no items are partially admitted

#### Scenario: A collection document with one bad item
- **WHEN** a collection document contains valid items and one item with a fabricated anchor
- **THEN** the valid items are admitted, the bad item is dropped, and the rejected-item count is one
