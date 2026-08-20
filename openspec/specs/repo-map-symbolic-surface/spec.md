# repo-map-symbolic-surface specification

## Purpose

Model-free context operations return file overviews, exported definition sites, and textual references from the same pinned Repo Map used by the review. Each reply reports freshness and the limits of its lookup method.

## Requirements

### Requirement: A file symbol overview comes from the deterministic snapshot

`context.overview` SHALL return each structurally extracted, top-level exported symbol's name, kind, and line at the pinned base ref. It SHALL read the snapshot's per-file symbol shards, invoke no model, and require no LSP. Its `canvasOps@2` response SHALL contain `{data, evidence, freshness, truncated}` and report the total and pagination cursor when more symbols remain.

#### Scenario: Overview without reading the file

- **WHEN** an agent calls `context.overview` for a file at the pinned base OID
- **THEN** it receives the file's top-level exported symbol names, kinds, and lines from the snapshot shards
- **AND** the reply carries a freshness check, and no whole-file content is returned

### Requirement: Go-to-definition reports structural matches without claiming LSP resolution

`context.symbol` SHALL resolve an exported symbol name to every structurally extracted definition site at the pinned base ref. Each site SHALL include its path, line, declaration kind, and workspace scope. One matching site MAY be labelled `exact` with method `structural`. Several matching sites SHALL be labelled `guess` with method `structural` and the candidate count. The operation SHALL NOT claim LSP resolution or chase a re-export to its origin, and it SHALL invoke no model.

#### Scenario: One structural definition is exact and several are a guess

- **WHEN** `context.symbol` finds one exported definition for a name and later finds several definitions for another name
- **THEN** the first result is labelled `exact` with method `structural`
- **AND** the second result is labelled `guess` with method `structural` and reports the candidate count

### Requirement: Find-references reports textual name occurrences

`context.references` SHALL return every indexed occurrence of an identifier name at the pinned base ref, with each site's path, line, and workspace scope. It SHALL label a non-empty result `guess` with method `textual`. The operation SHALL state that it is name-based, may include declarations, comments, and string literals, and cannot distinguish different symbols that share a name. It SHALL invoke no model.

#### Scenario: Textual references never claim exactness

- **WHEN** `context.references` finds one or more occurrences of a name
- **THEN** the result is labelled `guess` with method `textual`
- **AND** pagination reports the total and a cursor when more occurrences remain

### Requirement: Symbolic reads do not raise a coverage obligation

A `context.symbol` or `context.references` resolution SHALL emit no read event and SHALL NOT move review coverage. Looking up a definition or reference is not evidence that the agent read the diff.

#### Scenario: An agent definition lookup is not a read

- **WHEN** an agent resolves a definition or references through the context operations
- **THEN** no read event is emitted and no coverage obligation is raised

### Requirement: The symbolic ops pin to the same baseline as the structural map

`context.overview` / `context.symbol` / `context.references` SHALL pin to the same base OID (or merged base+overlay snapshot) as `context.map`, and a stale pin SHALL refuse rather than serve against a mismatched ref.

#### Scenario: A stale symbolic pin refuses

- **WHEN** a symbolic op is requested against a base OID that no fresh snapshot covers
- **THEN** it refuses with a typed staleness failure rather than returning a result from another ref
