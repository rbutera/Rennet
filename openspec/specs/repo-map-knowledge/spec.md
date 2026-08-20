# repo-map-knowledge specification

## Purpose

The Repo Map knowledge layer stores evidence-backed statements, labels hypotheses, discloses invalidation, and keeps every model call outside deterministic structural reads.

## Requirements

### Requirement: Every knowledge statement carries evidence, provenance, confidence, and its snapshot

A learned knowledge statement SHALL carry evidence anchors that resolve, provenance, a confidence, and the snapshot id it was learned against. A model-derived statement SHALL be a labelled hypothesis until confirmed. A statement whose evidence anchors do not resolve SHALL be invalid.

#### Scenario: A hypothesis renders labelled

- **WHEN** a model-derived statement has not been confirmed
- **THEN** it is returned labelled as a hypothesis, never as an asserted fact

#### Scenario: An unanchored statement is invalid

- **WHEN** a statement's evidence anchors do not resolve against its snapshot
- **THEN** it is invalid and is not served as knowledge

### Requirement: context.knowledge returns statements verbatim with labels intact

`context.knowledge` SHALL return statements verbatim with their evidence, confidence, and hypothesis labels intact. A statement whose snapshot inputs the current delta pass invalidated SHALL be withheld and disclosed as invalidated-pending, never silently absent.

#### Scenario: An invalidated statement is disclosed, not dropped

- **WHEN** a statement's snapshot inputs were invalidated by an in-flight delta pass
- **THEN** `context.knowledge` discloses it as invalidated-pending rather than returning it as current or omitting it silently

### Requirement: Knowledge is stored local-first and promoted with the map

The knowledge layer SHALL be stored locally at `~/.rennet/projects/<escaped-path>/knowledge/` by default, and promoted (opt-in, default off) into `<repo>/.rennet/knowledge/` alongside the promoted structural map. A promoted knowledge set SHALL be validated on discovery like the map, never trusted blind.

#### Scenario: Promotion carries knowledge with the map

- **WHEN** a user promotes the Repo Map
- **THEN** the knowledge set is written under `<repo>/.rennet/knowledge/` on the default branch and validated on later discovery

### Requirement: The model boundary stays at the knowledge layer

No model turn SHALL enter the structural map or the symbolic lookup operations. Only knowledge enrichment and model-backed novelty adjudication SHALL call a model. Those calls SHALL be uncapped and SHALL stay outside a review's critical path.

#### Scenario: A review's required layers are model-free

- **WHEN** a review requires the structural map or a symbolic resolution
- **THEN** those are served without any model turn, and only knowledge enrichment (never required for the review to proceed) uses a model
