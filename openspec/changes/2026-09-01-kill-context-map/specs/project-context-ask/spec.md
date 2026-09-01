## REMOVED Requirements

### Requirement: Project-scoped context ask

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. The `project.contextAsk` command and the `context.ask` context tool are gone. Selection-aware questions during a review are still served by `review.ask`.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.

### Requirement: Conversational rail in the Context Map surface

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. The surface it lived in is deleted.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.
