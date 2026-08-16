# settings-resolution Specification

## Purpose
Every setting resolves through one declared schema and one layered resolver, and every resolved value can say where it came from — so the settings surface explains, resets, and pins values instead of hand-wiring each row.
## Requirements
### Requirement: Settings keys are declared in one schema registry
Every consumed setting SHALL be declared in a single schema registry entry stating its value schema, its builtin default, the layers permitted to set it, its merge strategy, and how a value is rendered for provenance display. Resolution and the settings surface SHALL derive from the registry; there SHALL be no consumed setting that resolves outside it. A value in a config file that fails its key's declared schema SHALL be treated exactly as the shipped malformed-config semantics treat it today (the file's layer is refused for edits and contributes nothing), never silently coerced or dropped.

#### Scenario: Every live setting is registered
- **WHEN** the registry is enumerated
- **THEN** it contains at least the appearance scheme, per-repo map visibility, per-repo promotion, and per-repo execution locus, each with a builtin default and a declared merge strategy

#### Scenario: Adding a setting does not add a resolver
- **WHEN** a new key is registered with a schema, default, and permitted layers
- **THEN** it resolves through the same generic resolution path as every existing key, with no per-key resolve function

### Requirement: Values resolve through the layered ladder with provenance as the return type
A setting SHALL resolve by folding the layers `builtin < detected < global < repo`, in that fixed order, where only layers with a live producer contribute: `builtin` from the registry default, `detected` from environment-derived detection (today: execution-locus auto-detection), `global` from the user's global config, `repo` from the repo's app-side config. The most specific offered value is effective (all currently registered keys merge by `replace`). Every resolution SHALL return the effective value together with its source layer and the full lowest-first list of contributing offers with exactly one flagged effective; there SHALL be no way to read a bare value without provenance. Layers and merge strategies beyond those with a live producer SHALL NOT be resolved, faked, or surfaced.

#### Scenario: Locus resolves through the ladder, not around it
- **WHEN** a repo under a WSL distro root has no persisted locus override
- **THEN** the effective locus is the detected distro, its provenance names the `detected` layer, and the contributions list shows the detection alongside the builtin default

#### Scenario: A repo override outranks detection
- **WHEN** a repo has a persisted locus override differing from what detection offers
- **THEN** the effective locus is the repo value, and the provenance still lists the suppressed detected offer as a non-effective contribution

#### Scenario: Provenance is the resolver's own answer
- **WHEN** the settings surface displays any value's explanation
- **THEN** it renders the contributions returned by the resolver for that value, not a recomputed account that could disagree with the engine

### Requirement: Every settings row explains, resets, and pins without ceremony
The per-repo settings surface SHALL, for every repo-scoped setting: display the effective value with its source layer and full contributions (Explain); offer reset-to-inherit when the value is explicitly set at the repo layer, which removes the repo-layer entry so the value falls back down the ladder (Reset); and offer pin-at-repo when the effective value is inherited or detected, which writes the current effective value explicitly at the repo layer so a change in a lower layer or in detection no longer moves it (Pin). The appearance scheme SHALL offer the equivalent reset at the global layer. Explain, Reset, and Pin SHALL be plain reads and plain config writes — no confirmation step, no approval flow, no gate of any kind.

#### Scenario: Reset returns a value to inheritance
- **WHEN** the user resets a repo's explicitly set visibility
- **THEN** the repo-layer entry is removed, the effective value is whatever the remaining ladder resolves, and the row's provenance now shows the effective value's true lower-layer source

#### Scenario: Pin freezes a detected locus
- **WHEN** the user pins a repo whose locus is currently auto-detected as a WSL distro
- **THEN** that distro is written as the repo's explicit locus, the row shows the repo layer as the source, and subsequent detection changes do not alter the effective locus

#### Scenario: No ceremony on any control
- **WHEN** the user invokes Explain, Reset, or Pin
- **THEN** the action completes in that single interaction, with no confirmation dialog or acknowledgement step

#### Scenario: Malformed config refuses reset and pin
- **WHEN** a repo's config file is malformed and the user attempts Reset or Pin
- **THEN** the write is refused with the file left byte-for-byte untouched, and the surface states the refusal plainly

### Requirement: Old configs parse additively with no migration
Existing global and per-repo config files written before this capability SHALL parse and resolve unchanged: absent keys resolve down the ladder, no migration step runs, and no file is rewritten except by an explicit user edit through the surface.

Existing settings-view rows without `locusProvenance` SHALL be accepted at the protocol boundary and normalized to the canonical new row shape with derived locus provenance. No protocol version handshake or migration ceremony SHALL be introduced.

#### Scenario: A pre-existing repo config keeps its meaning
- **WHEN** a repo config written before this capability (for example carrying only `version` and `visibility`) is read
- **THEN** its values resolve at the repo layer exactly as before, and the file is not rewritten by the read

#### Scenario: An old settings row normalizes at the boundary
- **WHEN** a settings-view row without `locusProvenance` is parsed
- **THEN** it is accepted and the parsed row carries derived `detected` or `repo` locus provenance matching `locusOverridden`

