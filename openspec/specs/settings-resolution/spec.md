# settings-resolution specification

## Purpose

Every setting resolves through one declared schema and one layered resolver. The resolved value includes its provenance, so the settings screen can explain, reset, and pin it without per-row resolution code.

## Requirements

### Requirement: Settings keys are declared in one schema registry
Every consumed setting SHALL be declared in a single schema registry entry stating its value schema, builtin default, permitted layers, merge strategy, and provenance formatter. The resolver and settings screen SHALL derive from the registry. No consumed setting SHALL resolve outside it. If a config value fails its declared schema, the resolver SHALL exclude the file's layer and edits SHALL leave the malformed file untouched. It SHALL NOT coerce or drop the invalid value silently.

#### Scenario: Every live setting is registered
- **WHEN** the registry is enumerated
- **THEN** it contains at least the appearance scheme, per-repo map visibility, per-repo promotion, and per-repo execution locus, each with a builtin default and a declared merge strategy

#### Scenario: Adding a setting does not add a resolver
- **WHEN** a new key is registered with a schema, default, and permitted layers
- **THEN** it resolves through the same generic resolution path as every registered key, with no per-key resolve function

### Requirement: Values resolve through the layered ladder with provenance as the return type
A setting SHALL resolve by folding the layers `builtin < detected < global < repo` in that order. Only layers with a live producer contribute. The registry supplies `builtin`, environment detection supplies `detected`, the user config supplies `global`, and the repository's app-side config supplies `repo`. The most specific offered value is effective, and every registered key uses `replace`. Every resolution SHALL return the effective value, its source layer, and the lowest-first list of contributions with exactly one marked effective. Callers SHALL NOT read a bare value without provenance. Resolution SHALL NOT report layers or merge strategies without a live producer.

#### Scenario: Locus resolves through the ladder, not around it
- **WHEN** a repo under a WSL distro root has no persisted locus override
- **THEN** the effective locus is the detected distro, its provenance names the `detected` layer, and the contributions list shows the detection alongside the builtin default

#### Scenario: A repo override outranks detection
- **WHEN** a repo has a persisted locus override differing from what detection offers
- **THEN** the effective locus is the repo value, and the provenance still lists the suppressed detected offer as a non-effective contribution

#### Scenario: Provenance is the resolver's own answer
- **WHEN** the settings screen displays any value's explanation
- **THEN** it renders the contributions returned by the resolver for that value, not a recomputed account that could disagree with the engine

### Requirement: Editable settings explain, reset, and pin without ceremony

The settings screen SHALL show every setting's effective value, source layer, and contributions. Editable repository settings SHALL offer Reset and Pin. Reset SHALL remove an explicit repo-layer value so resolution falls back to the remaining layers. Pin SHALL write an inherited or detected effective value at the repo layer so lower-layer or detection changes no longer move it. Map promotion SHALL remain a read-only status because promotion uses its own explicit action. The appearance scheme SHALL offer the equivalent reset at the global layer. Explain, Reset, and Pin SHALL be direct reads and config writes with no confirmation, approval, or acknowledgement step.

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
- **THEN** the write is refused with the file left byte-for-byte untouched, and the screen states the refusal plainly

### Requirement: Sparse configs resolve without migration

Global and per-repo config files MAY omit registered keys. Absent keys SHALL resolve through the remaining layers, and reads SHALL NOT rewrite the file. Settings-view rows MAY omit `locusProvenance`; the protocol boundary SHALL derive it from `locusOverridden` without a version handshake or migration step.

#### Scenario: A sparse repo config resolves

- **WHEN** a repo config carries only `version` and `visibility`
- **THEN** visibility resolves at the repo layer, absent keys inherit, and the read does not rewrite the file

#### Scenario: A settings row without locus provenance normalizes at the boundary
- **WHEN** a settings-view row without `locusProvenance` is parsed
- **THEN** it is accepted and the parsed row carries derived `detected` or `repo` locus provenance matching `locusOverridden`
