## 1. Remove the knowledge layer

- [x] 1.1 Delete `core/knowledge/` (partition batcher, Louvain batching, neighbour map, deterministic merge, `map-verify` seat, journal, scope plan, statement set) — `52920b749`
- [x] 1.2 Remove the `map-scope`, `partition-worker` and `map-verify` council jobs and the Context-Map Workers role — `52920b749`
- [x] 1.3 Remove `project.contextMap`, `project.contextAsk`, `project.knowledgeDisposition` and the `context.knowledge` / `context.ask` tools; command snapshot updated — `52920b749`
- [x] 1.4 Remove the Context Map surface, its command-menu entry and the Map pill (session pill is History · Diff) — `52920b749`
- [x] 1.5 Remove `rennet map --enrich`; `rennet map` calls no model — `52920b749`
- [x] 1.6 Drop `graphology` and `graphology-communities-louvain` from the manifests and lockfile — `52920b749`
- [x] 1.7 Remove the knowledge half of the Delta packet (`selectPacketKnowledge`, the selection modes, statement counts) — `52920b749`

## 2. The drafter reads the checkout

- [x] 2.1 `DeltaPacket.patchset` carries the reviewed range's identity (`baseRef`, `baseOid`, `headOid`; the pinned tree for a working-tree review), never host paths — `52920b749`, `a5bf28522`
- [x] 2.2 Three-layer drafter prompt: lens instructions, a task line naming the range and stating the cwd is the reviewed checkout, the packet inventory with hunk bodies redacted at render; coverage stays over the inventory's hunk ids — `52920b749`
- [x] 2.3 `investigate-before-you-draft.md` shared partial in every lens prompt; `design.md`'s tool prohibition rescoped to artifact selection — `52920b749`
- [x] 2.4 Add-project is one scout → structural-map run; the ready card reads "Project Ready" with scope and file counts — `52920b749`

## 3. Specs and docs

- [x] 3.1 Killed capabilities' specs removed from `openspec/specs/`; `repo-map-delta-pass` and `wsl-execution-mode` amended in place; matching deltas kept in this change's `specs/` — `52920b749`
- [x] 3.2 Design and tasks written as built (2026-09-03) so the change archives with `--skip-specs`, the promoted specs already matching
