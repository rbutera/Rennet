## REMOVED Requirements

### Requirement: Every knowledge statement carries evidence, provenance, confidence, and its snapshot

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. The whole statement store is deleted.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.

### Requirement: context.knowledge returns statements verbatim with labels intact

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. The `context.knowledge` tool is removed from the context-tool set.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.

### Requirement: Knowledge is stored local-first and promoted with the map

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. Promotion now writes `.rennet/map/` only. `repo-map-storage` already describes promotion without naming knowledge and is unchanged.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.

### Requirement: The model boundary stays at the knowledge layer

**Reason**: The knowledge swarm burned the usage limit (48 worker turns plus a verify pass on Rennet itself, never proved under the five-minute bar) and its contribution to the Delta packet blew the drafter prompt on any large branch. It is deleted, not replaced in kind. There is no model-backed layer in the Repo Map at all. Every pass over the snapshot is deterministic — the stronger property this requirement was approximating.

**Migration**: No migration. A lens drafter now runs as a harness agent inside the reviewed checkout, is told which commits it is reviewing, and reads the change with its own tools (`git diff`, `git log`, file reads, grep). Stored statement sets under `~/.rennet/projects/<esc>/knowledge/` are inert and may be deleted.
