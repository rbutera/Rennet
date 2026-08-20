# project-context-ask Specification

## Purpose
Defines evidence-backed questions over one project's persisted structural map and knowledge set from the Context Map conversation rail.
## Requirements
### Requirement: Project-scoped context ask
The system SHALL expose a `project.contextAsk` command that answers a free-text question about a project by running the existing context-ask engine over the project's persisted snapshot and local knowledge set, keyed by `{repoKey, baseOid}` at the persisted tip, using the user's own installed harness for the model turn.

#### Scenario: Question answered with evidence
- **WHEN** `project.contextAsk` is invoked with a question and a usable harness is available and the persisted snapshot gates fresh
- **THEN** the command returns an answer carrying its evidence and cost, in the existing context-ask result shape

#### Scenario: No usable harness
- **WHEN** `project.contextAsk` is invoked and no harness is available
- **THEN** the command returns a failed result naming the harness health reason, and the surface renders that state

#### Scenario: Snapshot unavailable
- **WHEN** the persisted snapshot for the project is absent, stale, or fails integrity
- **THEN** the command returns the typed refusal from the snapshot gate rather than answering over wrong context

### Requirement: Conversational rail in the Context Map surface
The Context Map surface SHALL include a conversation rail that sends the user's questions through `project.contextAsk` and renders answered, unanswered, and failed results distinctly, preserving the conversation within the surface's lifetime.

#### Scenario: Asking from the rail
- **WHEN** the user submits a question in the rail
- **THEN** the question and its typed result render in the rail, with evidence anchors shown for answered results
