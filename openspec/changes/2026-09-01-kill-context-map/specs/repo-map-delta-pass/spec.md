## REMOVED Requirements

### Requirement: An uncapped LLM knowledge pass runs off the same trigger and never blocks review

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. The baseline-advance trigger now runs the deterministic incremental pass only. No pass over the Repo Map invokes a model, so the requirement's closing clause — "Only this pass, not the structural pass, may invoke a model" — is satisfied by there being no such pass.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.
