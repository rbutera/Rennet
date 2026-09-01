# Kill the context map and the knowledge swarm

Authored 2026-09-01 against `main @ e835a1b4` (v0.5.0). Supersedes
`archive/2026-09-01-b06-context-map-swarm` (#460).

## Why

The model-backed knowledge layer cost more than it returned, in two ways that
were both measured rather than argued.

**It burned the usage limit.** A clean map of Rennet itself was 48 worker turns
plus a verify pass, and the first complete 16-lane run crossed the pageout guard
after five minutes without finishing. Every baseline advance re-spent some
fraction of that. The five-minute bar in the B06 packet was never proved; the
proof runs kept finding a new ceiling instead.

**It made lens drafting fail at the model boundary.** The scoped knowledge
selection rode into the Delta packet, which was already inlined verbatim into
every drafter prompt alongside the whole serialized diff. The capture cap is
2 MB, far above what a prompt can carry, and nothing stood between them — so a
large branch died with a prompt-too-long error on every lens, every turn.

The replacement is strictly simpler, and it is the thing the product already
had. A lens drafter is a harness agent running **in the reviewed checkout**,
under the same toolset the coding agents use. Tell it which commits it is
reviewing and it reads the change itself — `git diff`, `git log`, file reads,
grep — and cites what it actually read. A pre-computed dump of somebody else's
reading was never better evidence than reading; it was only more expensive, and
it was one more thing that could be stale.

## What Changes

**Removed.**

- The knowledge swarm end to end: `core/knowledge/`, the partition batcher,
  Louvain module batching, the neighbour map, the deterministic merge, the
  `map-verify` seat, the journal, the scope plan, and the stored statement set.
- The `map-scope`, `partition-worker`, and `map-verify` Council jobs, and the
  **Context-Map Workers** review role.
- The `project.contextMap`, `project.contextAsk`, and
  `project.knowledgeDisposition` protocol commands, and the `context.knowledge`
  and `context.ask` context tools.
- The Context Map UI surface, its command-menu entry, and the **Map** pill (the
  session pill is now History · Diff).
- The `rennet map --enrich` CLI leg. `rennet map` calls no model and needs no
  harness.
- `graphology` and `graphology-communities-louvain` from the dependency
  manifest.
- The knowledge half of the Delta packet: `selectPacketKnowledge`, the
  `import-graph` / `projected-full` / `unprojected` selection modes, and the
  packet's statement counts.

**Changed.**

- `DeltaPacket.patchset` carries the reviewed range's identity — `baseRef`,
  `baseOid`, `headOid`, never host paths.
- The drafter prompt is three layers: the lens instructions (payload), a task
  line naming the reviewed range and stating that the working directory *is* the
  reviewed checkout, and the packet **inventory** (context) — the hunk index
  with its ids, headers, and spans, but **without** the verbatim hunk bodies.
  Coverage stays taught-or-skipped over those exact hunk ids.
- The five lens prompts gain an "Investigate before you draft" section.
  `design.md`'s "do not rediscover files with tools" is rescoped to artifact
  selection; investigating the change is now the expected posture.
- The add-project run is one scout → structural-map sequence. Its ready card
  reads **Project Ready** with scope and file counts.

**Kept.** Everything deterministic. The Repo Map snapshot, symbol and reference
shards, the import graph and its resolution rules, fan-in and the blast radius,
overlays, the project scout, novelty, nested and workspace composition, and the
`rennet map` CLI.

## Spec impact

The four killed capabilities' promoted specs are moved wholesale to
`archive/2026-09-01-kill-context-map/specs/`: `project-context-map`,
`project-context-ask`, `knowledge-disposition`, `repo-map-knowledge`. This
change's own `specs/` carries the matching `## REMOVED Requirements` deltas, one
per capability, each naming its reason.

Amended in place, with the same edit recorded as a delta here:
`repo-map-delta-pass` (the uncapped LLM knowledge pass requirement is removed; no
pass invokes a model) and `wsl-execution-mode` (knowledge enrichment drops out of
the in-locus model-turn list, and its scenario with it).

Unchanged: `repo-map-storage`, `repo-map-symbolic-surface`, `model-council`,
`live-end-to-end-review` — none of them named the knowledge layer.

Left standing, with a caveat: `nested-repo-maps` and `repo-map-net-novel` still
say the word *knowledge*, in a prohibition (a parent composition must not copy a
child's knowledge) and in a citation source. Both are now vacuous rather than
wrong, and neither drove any deleted code. They are a follow-up edit, not a
blocker.
