# session-context-files Specification

## Purpose
Progressive disclosure for every model turn: context is written as files under the session's bound root and named by path in the prompt, so an agent reads what it decides it needs, the same way it reads the checkout, and no prompt ever carries context inline.
## Requirements
### Requirement: No prompt carries context inline

A prompt sent to any harness (a sidecar seat thread, an ephemeral Claude session, a Codex execution, the handoff thread) SHALL contain its instructions and path references only. It SHALL NOT interpolate a change inventory, a diff, a file body, a board, a prior draft, discovered artifacts, a dossier, an evidence manifest, a convention catalogue, a work order, or any other data beyond the instruction text. A short quoted excerpt selected by the reviewer for an anchored chat question (at most 600 characters) is the one admitted exception.

#### Scenario: Seat prompt names the context directory
- **WHEN** a lens seat's drafting prompt is rendered
- **THEN** it names the session's context directory and its index file, and contains no JSON payload

#### Scenario: A change that grows a prompt states its size
- **WHEN** a pull request changes what any turn sends
- **THEN** its description states the prompt's size before and after

### Requirement: Session context lives under the bound root and is indexed

Anything a turn may need beyond its instructions SHALL be written as a file under `.rennet/context/<sessionId>/` in the session's bound root, with a `README.md` in that directory listing every file, what it holds, and when to read it. One writer SHALL own that directory; a turn that needs new context adds a file through it. The directory SHALL be listed in the Rennet-managed ignore block of the repository's `.rennet/.gitignore`, so no git operation on the reviewer's behalf stages it.

#### Scenario: Context written before the seats start
- **WHEN** a generation starts
- **THEN** the context directory for the session exists with its index and the files the seats are told about before the first seat turn is dispatched

#### Scenario: Context is never staged
- **WHEN** a round commits in the bound workspace
- **THEN** no file under `.rennet/context/` is in the commit

### Requirement: Session context is purged with the session

The session's context directory SHALL be deleted when the session is archived, on the same path that deletes the session's sidecar threads, and SHALL NOT be deleted before then, so a reopened transcript or a resumed round still finds its files. A daemon start SHALL sweep context directories whose session no longer exists.

#### Scenario: Archive purges context
- **WHEN** a session is archived
- **THEN** its context directory is gone from the bound root and the archive account reports it

#### Scenario: Orphaned context after a crash
- **WHEN** the daemon starts and finds a context directory for a session that no longer exists
- **THEN** the sweep removes it and reports the count in the daemon log

