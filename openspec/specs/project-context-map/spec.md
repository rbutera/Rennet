# project-context-map Specification

## Purpose
Defines the persisted project map read, the Context Map interface, and the distinction between deterministic structure and model-authored knowledge.
## Requirements
### Requirement: Persisted Repo Map read command
The system SHALL expose a `project.contextMap` command that reads the project's persisted Repo Map without rebuilding the snapshot or running a model turn. The result SHALL contain the queryable `ProjectMap` of files, scopes, dependency edges, entry points, tests, ownership, and conventions, plus the local `KnowledgeSet` when one exists.

#### Scenario: Persisted map exists
- **WHEN** `project.contextMap` is invoked for a project whose snapshot manifest is persisted in the local store
- **THEN** the command returns the `ProjectMap` for the stored tip plus the local knowledge set (or `null` when none exists), identifying the base ref and OID it was read at

#### Scenario: No persisted map
- **WHEN** `project.contextMap` is invoked for a project with no persisted snapshot
- **THEN** the command returns a typed absent result naming the reason, and never fabricates or partially serves a map

### Requirement: Context Map surface
The UI SHALL provide a per-project Context Map surface reachable from the project detail view. It SHALL present structure as a roll-up tree of scopes, directories, and files with rolled-up file counts. A neighborhood graph SHALL show only the selected node and its direct dependency edges. The surface SHALL display snapshot freshness and a knowledge panel for the selection.

#### Scenario: Opening the surface
- **WHEN** the user opens the Context Map from a project's detail view
- **THEN** the app navigates to a `contextMap` surface for that project, loads `project.contextMap`, and renders the tree, graph, and knowledge panel from the returned data

#### Scenario: Selecting a scope re-centers the graph
- **WHEN** the user selects a different scope in the tree or clicks a neighbor node in the graph
- **THEN** the neighborhood graph re-centers on that scope showing only its direct edges, and the knowledge panel filters to statements about the selection

### Requirement: Knowledge rendered as labelled hypotheses
The Context Map surface SHALL render knowledge statements visually distinct from deterministic structure: each statement MUST show its confidence, status, and evidence anchors, and a statement whose status is not `confirmed` MUST be presented as a hypothesis, never as an asserted fact.

#### Scenario: Hypothesis display
- **WHEN** the knowledge panel renders a statement with status `hypothesis`
- **THEN** the statement is labelled as a hypothesis with its confidence and evidence visible
