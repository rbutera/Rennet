## ADDED Requirements

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
The validator SHALL reject a graph document wholesale on any error, and SHALL admit a collection document item-by-item — dropping invalid items while admitting valid ones — and SHALL always report a visible rejected-item count.

#### Scenario: An atomic document with one bad anchor
- **WHEN** a graph document contains a single unresolvable anchor
- **THEN** the whole document is rejected and no items are partially admitted

#### Scenario: A collection document with one bad item
- **WHEN** a collection document contains valid items and one item with a fabricated anchor
- **THEN** the valid items are admitted, the bad item is dropped, and the rejected-item count is one
