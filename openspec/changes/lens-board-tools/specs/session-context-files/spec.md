## MODIFIED Requirements

### Requirement: No prompt carries context inline

A prompt sent to any harness (a sidecar seat thread, an ephemeral Claude session, a Codex execution, the handoff thread) SHALL contain its instructions and path references only. It SHALL NOT interpolate a change inventory, a diff, a file body, a board, a prior draft, discovered artifacts, a dossier, an evidence manifest, a convention catalogue, a work order, or any other data beyond the instruction text. A short quoted excerpt selected by the reviewer for an anchored chat question (at most 600 characters) is the one admitted exception.

A TOOL RESULT is not a prompt payload and is not covered by this rule — it is the answer to a call the agent chose to make, which is progressive disclosure working. It is still bounded: a tool SHALL NOT return a diff, a file body, a whole board or a prior draft, and a result that names more than it can carry SHALL name it by path and range rather than inlining it. A tool that returns violations SHALL return pointers only.

#### Scenario: Seat prompt names the context directory

- **WHEN** a lens seat's drafting prompt is rendered
- **THEN** it names the session's context directory and its index file, and contains no JSON payload

#### Scenario: A tool result stays a pointer

- **WHEN** a seat's whole-board check returns violations
- **THEN** the result carries one pointer per violation, each naming an element and where the problem is, and carries no board, no draft and no restated instructions

#### Scenario: A change that grows a prompt states its size

- **WHEN** a pull request changes what any turn sends
- **THEN** its description states the prompt's size before and after, and where a turn gained a tool surface, the size of that surface
