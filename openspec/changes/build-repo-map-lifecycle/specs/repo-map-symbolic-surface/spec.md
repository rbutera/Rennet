# repo-map-symbolic-surface

The "IDE for the agent": model-free symbolic navigation ops over the Repo Map so the orchestrator and review agents pull symbol-granular context on demand instead of dumping whole files into their windows. Context-window economy is the goal, not a side effect. Grows the `canvasOps@2` `context.*` family; consumes #23's LSP engine substrate (does not subsume it). Adopts codeindexer.dev's IDE-surface model; diverges by riding our existing map-not-container envelope and tier-labelled honesty.

## ADDED Requirements

### Requirement: A file symbol overview is served from the deterministic snapshot

`context.overview` SHALL return a file's top-level symbols and signatures (no bodies) at the pinned base ref, served from the snapshot's existing per-file symbol shards. It SHALL be model-free and SHALL NOT require the LSP substrate, so it ships on the wave-1 foundation alone. It SHALL ride the `canvasOps@2` envelope (`{data, evidence, freshness, truncated}`) and carry staleness per reply.

#### Scenario: overview without reading the file

- **WHEN** an agent calls `context.overview` for a file at the pinned base OID
- **THEN** it receives the file's top-level symbols and signatures from the snapshot shards
- **AND** the reply carries a freshness check, and no whole-file content is returned

### Requirement: Go-to-definition is served tier-labelled over the LSP substrate

`context.symbol` SHALL return a symbol's definition (signature, doc, definition location, first lines, origin path) with an honest **tier label**: `exact` for an LSP answer, `guess` for a tree-sitter answer, listing candidates when degraded. It SHALL consume #23's materialization port, position mapper, and degraded-result detector rather than re-implement them, and SHALL be model-free. A degraded result SHALL NOT be rendered as an exact target.

#### Scenario: exact vs guess are labelled honestly

- **WHEN** `context.symbol` resolves a definition via the LSP (exact) or via tree-sitter (guess)
- **THEN** the result carries the corresponding tier label
- **AND** a degraded resolution lists its candidates instead of asserting a single wrong target

### Requirement: Symbolic reads do not raise a coverage obligation

A `context.symbol` or `context.references` resolution SHALL emit no read event and SHALL NOT move review coverage — the agent inspecting a definition is not the agent reading the diff (the #23 noninterference property applies to the agent surface too).

#### Scenario: an agent definition lookup is not a read

- **WHEN** an agent resolves a definition or references via the symbolic surface
- **THEN** no read event is emitted and no coverage obligation is raised

### Requirement: The symbolic ops pin to the same baseline as the structural map

`context.overview` / `context.symbol` / `context.references` SHALL pin to the same base OID (or merged base+overlay snapshot) as `context.map`, and a stale pin SHALL refuse rather than serve against a mismatched ref.

#### Scenario: a stale symbolic pin refuses

- **WHEN** a symbolic op is requested against a base OID that no fresh snapshot covers
- **THEN** it refuses with a typed staleness failure rather than returning a result from another ref
