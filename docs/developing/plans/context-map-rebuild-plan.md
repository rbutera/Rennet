---
title: Context map rebuild plan
description: Replace the flat knowledge swarm with a deterministic front half (import graph, module batching), skeleton-fed tiered workers, deterministic merge, retrieval-based consumption, and the removal of every seat-hamstringing mechanism.
status: planned
tracking: https://github.com/rbutera/rennet/issues/584
---

This plan replaces the context-map swarm designed in
[#460](https://github.com/rbutera/rennet/issues/460) (workstream B06) with an
architecture adapted from
[Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT),
refined with Rennet's model-council tiers and anchored-statement schema. It
resolves the ≤5-minute generation requirement
([#584](https://github.com/rbutera/rennet/issues/584)) and the
persistence-honesty defect
([#581](https://github.com/rbutera/rennet/issues/581)), and carries a product
ruling on seat freedom. Rule Zero governs throughout: no gates, no ceremony,
capable seats are the product.

## Why the current swarm is being replaced

Measured on Rennet itself (2,383 files), the B06 swarm has never succeeded:

- 200 partitions × ~78 s per light-tier worker at a hard-coded concurrency of
  4 projects to ~67 minutes of wall time.
- The single verify seat then received all ~1,900 minted statements in one
  unbounded prompt and died with "Prompt is too long" — every time, with the
  whole run discarded (all-or-keep-prior, no checkpoint).
- The failure was invisible: `runKnowledgePass` collapsed the outcome union to
  a boolean, proactive rehydration never called `onError`, and narration was
  broadcast on a command id no client subscribes to.

The 200-partition count is not cap arithmetic — `buildPartitions` runs at a
120-file cap, but every workspace scope and subtree split mints its own slice,
so the mean slice is ~12 files. The deeper fault is architectural: partitions
are directory-shaped rather than module-shaped, workers receive a bare path
list and re-derive everything from source, and a model seat is asked to verify
what a script could check.

## What the study found

Three investigations inform the design (full reports in the session record;
key citations inline below).

**Understand-Anything's load-bearing moves.** (1) The LLM never reads source
by default — a deterministic tree-sitter pass extracts symbols, line ranges,
exports, and a call graph, and workers annotate that skeleton. (2) Partitions
are Louvain communities over a repo-wide import graph (~25–35 files), each
carrying a `neighborMap` of cross-batch neighbours' exported symbols, so
cross-partition edges survive partitioning. (3) Exclusion is the biggest
measured lever — a generated, user-editable ignore layer for tests, fixtures,
vendored and generated code (their per-language measurements run 15–67 % of
total tokens). (4) There is no default verify seat: a deterministic merge pass
re-derives every import-shaped fact from the authoritative import map (their
workers drop ~25 % of edges in practice) and validation is a generated script;
the LLM reviewer is opt-in. Refresh is fingerprint-gated: content hash says
"unchanged", a signature diff separates cosmetic from structural, and only
structural changes reach a model. Consumption is never a full dump — every
consumer greps the graph for a keyword-gated 1-hop subgraph.

**Rennet already owns most of the front half — wired to the wrong inputs.**
The structural snapshot (`packages/core/src/project-snapshot.ts`,
`packages/adapters/src/project-snapshot-source.ts`) is deterministic,
model-free, content-addressed, OID-pinned, and byte-reproducible
incrementally — stricter than Understand-Anything's scan. It already carries
per-blob export symbols and an identifier-occurrence reference index. What it
lacks: a repo-wide file-to-file import graph (the extraction regexes exist at
`packages/core/src/decomposition.ts:531-588` but run only over changesets, and
resolve only relative specifiers), community detection, and inventory-time
generated/vendored filtering (`isVendored`/`isGeneratedPath` exist but never
run over the snapshot inventory — a checked-in `dist/` is fully indexed
today).

**Seats are hamstrung in four mechanisms, none of them tool denial.** Ruling:
Rennet makes harnesses more efficient *additively*; it never denies a capable
harness the ability to explore. The audit found: (1) board lint grounds every
lens-drafter citation against changed files only
(`packages/server/src/runtime/round-collation.ts:119-131`), so off-diff
exploration produces elements the pipeline deletes; (2) every Codex utility
seat defaults to an empty temp cwd (`packages/adapters/src/codex-exec.ts:202`)
while the Claude legs of the same jobs get the repo root; (3) no Claude seat
can reach canvasOps (`ClaudeQueryOptions` has no `mcpServers` field) and Codex
utility seats get `-c mcp_servers={}`; (4) several prompts say "use ONLY the
facts below". The in-repo model of the intended posture is the
finding-verification contract: "you are NOT confined to it — read more of the
repository, and run it, when that is what it takes to know."

## Design

Four generation stages and a consumption redesign. The two-layer artifact
split survives: the deterministic structural map (`map/`) and the LLM
knowledge set (`knowledge/knowledge.json`) remain distinct, with statements
keeping their anchored, falsifiable schema — the thing Understand-Anything's
one-line node summaries lack.

### Stage 1 — deterministic front half (zero tokens)

1. **Import-edge shard.** Promote the changeset import extraction to a
   snapshot-wide, per-blob import shard: relative specifiers resolved against
   the inventory, workspace-alias and `@scope/pkg` specifiers resolved via the
   existing scope table. Content-addressed like the symbol and reference
   shards, so incremental rebuilds reuse unchanged blobs. This is the gating
   workstream: community batching, the neighbor map, and semantic fan-in all
   depend on it, and it upgrades `fanInIndexFromSnapshot` from name-based
   textual matching to real edges as a side effect.
2. **Inventory classification.** Run the existing lockfile / vendored /
   generated / binary classifiers over the snapshot inventory, not just
   changesets. Excluded files stay in the inventory (the map stays honest
   about what exists) but are not batched for mapping.
3. **Module batching.** Louvain community detection (graphology, the same
   dependency Understand-Anything uses, subject to the dependency standard)
   over the import graph, targeting ~25–35 files per batch with
   deterministic settings, alphabetic splitting for oversized communities,
   and pooling for singletons. Each batch carries a `neighborMap`: for every
   file, its cross-batch import neighbours with their exported symbol names,
   joined from the existing symbols shard. Expected effect on Rennet: roughly
   200 fragments → 40–60 module batches.
4. **Optional scoping seat.** A medium-tier model may read the classified,
   clustered tree and mark subtrees not worth mapping (the #584 approach (b)).
   With classification and clustering already deterministic, this judgment
   becomes cheap and reviewable. Whatever it excludes is recorded in the map
   as excluded-by-policy — completeness semantics stay honest.

### Stage 2 — light-tier workers

One turn per module batch, routed by the council as today (light tier,
Codex-first), cwd at the repository root. Input: the batch's symbol skeleton,
pre-resolved import data, and neighborMap. Output: anchored statements in the
existing schema, plus the semantic edges no parser can derive.

Departure from Understand-Anything, per the seat-freedom ruling: workers are
**free to read source**. Their pattern forbids re-reading to save tokens; we
get the saving from skeleton-first inputs instead, so reading becomes targeted
rather than forbidden. The mint-time anchor-or-drop rule remains the honesty
mechanism — citations must resolve, exploration is unbounded.

### Stage 3 — deterministic merge and a shrunken verify seat

A merge pass (script, not a seat) combines batch outputs, re-derives every
import-shaped fact from the authoritative edge shard, validates anchors
mechanically, and normalises ids. The medium-tier verify seat then sees only
what scripts cannot adjudicate — cross-cutting synthesis across batches — a
fraction of the statement volume that overflowed the old seat. The overflow
disappears structurally, not by chunking heroics.

Persistence honesty (#581) becomes tractable at this shape: per-batch results
journal as they complete, and the journal is promoted into the live store only
when the set is whole — work survives a crash, and a partial set never
presents as complete (the P1 invariant at
`packages/adapters/src/knowledge-swarm.ts:503-510` holds).

### Stage 4 — refresh

Per-blob content addressing already answers "unchanged" for free. Add a
signature-level diff (exports, declarations, params) so body-only edits
classify as cosmetic and cost zero tokens; only structural changes re-run
their batch's worker. `routeDelta` sharpens from partition-level to
file-level routing. Given how much agent-written churn is body-level, this is
where the steady-state token bill collapses.

**W4 built it and measured it.** The diff compares the two snapshots' per-blob
shards (exported name + kind, the generated bit, and the raw import specifiers;
lines excluded as cosmetic by definition), every unanswerable case falls to
structural, and `routeDelta` is handed the structural subset so a slice re-runs
only for a structural member. On Rennet's last 100 non-merge commits — 457 changed
files — 54% of files classify cosmetic and **17 of the 100 commits route zero
slices**, advancing the baseline for zero *worker* turns. Those figures were
measured on the export surface before imports joined the signature, so they are an
upper bound; and zero worker turns is not zero turns, because the statements
anchored in the edited files still reach the verify seat flagged and run it. Two
ceilings are stated rather than implied: the extractor sees exports only (so an
internal-only change reads as cosmetic, and a file that exports nothing — most
test files — is cosmetic on every edit), and it reads TypeScript/JavaScript only
(so a markdown or JSON edit is structural and pays its slice's turn). Full detail
in [Code intelligence](../concepts/code-intelligence.md).

### Consumption

The whole-set inlining into `DeltaPacket`
(`packages/server/src/runtime/lens-pipeline.ts:386-397`) is removed. In its
place, retrieval: changed files → 1-hop over the import graph → statements
anchored in that subgraph → that subset into drafter prompts, projected
through `queryKnowledge` so invalidated and rejected statements are dropped
(today's drafting path skips that projection — a defect this plan fixes in
passing). Retrieval sets the floor; exploration has no ceiling: every seat
gets canvasOps so it can pull more context on demand.

**W5b landed the retrieval half.** `selectPacketKnowledge`
(`packages/core/src/delta/knowledge-scope.ts`) projects, scopes to the changed
files' 1-hop import neighbourhood plus repo-level subjects, and caps at 80
statements per list — with the mode, the store total, the in-scope total and the
truncation count all disclosed in the packet, so a thinner input always says it
is thinner. Degradation goes toward more, never silently less: no import graph
gives the full projected set, no fresh snapshot gives the stored set marked
explicitly unprojected. The same seam (`assembleRoundCollation`) now feeds
`fanInIndexFromSnapshot` into the blast radius, so fan-in is an edge-backed
count rather than a *not assessed* mark whenever the snapshot can answer. The
exploration half — canvasOps on every seat — is W5a's.

### Un-hamstringing (same change, not a separate track)

- Widen board-lint citation grounding from `patchset.files` to the full
  snapshot inventory at the review commit — citations must still resolve, but
  a drafter that read beyond the diff can say so.
- Root Codex utility seats at the repository root, as the swarm seats already
  are.
- Give Claude seats an `mcpServers` surface and stop wiping the Codex utility
  seats' MCP table without substituting canvasOps.
- Re-examine each "use ONLY the facts below" prompt: keep the ones that are
  genuine task framing (delta-digest rephrases a structured account), drop
  the ones that are confinement.
- Delete the five stale "read-only session" comments describing the posture
  #259 removed.

## Speed accounting against the 5-minute bar

The deterministic half is seconds (Understand-Anything's equivalent runs a
459-file repo in ~12 s; ours is incremental besides). At ~50 batches, even
today's measured 78 s/turn clears the bar at concurrency ~13; skeleton-first
inputs shrink turns, and the 16 GB host has headroom for 8–16 lanes it never
had for 52. Any ramp test measures RSS per lane and swap pressure alongside
throughput — the machine, not the provider, is the ceiling. The concurrency
default becomes a named, tested policy rather than an unrevisited 4.

**W2 measured it, and the "~50 batches" premise is wrong.** On Rennet at the
end of W2: 2,420 files, 179 excluded by policy, 2,241 eligible, 3,506 resolved
import edges — and **201 slices**, not 52. Only 52 are module batches (1,152
connected files, median 27); the other 149 are directory-fallback slices holding
the 1,089 edge-less files at a mean of 7.3 each. At 201 turns the arithmetic
above lands near twenty minutes, roughly four times the bar. Batching itself is
65 ms and the clean deterministic build is ~35 s, so the cost is entirely in
turns. W3 owns the reduction: coalescing the fallback tail, and letting the
scoping seat decide which of those 1,089 files deserve a turn at all.

**W3 measured the coalesce, and the bar is still not met.** Adjacent fallback
slices now merge within one scope (or one top-level directory) up to 25 files: the
tail went 149 → **54** slices and the whole run went 201 → **105** slices (51
module batches over 1,154 files, 54 fallback slices over 1,095). Batching is
113 ms; the clean build is ~30 s.

105 turns × 78 s is 8,190 s of turn time. At the named concurrency of 8 that is
**~17 minutes of wall clock** — 17.6 with the build — against a five-minute bar.
Turn time ÷ lanes *is* the wall clock; there is no smaller figure to quote. To
clear the bar at 78 s/turn takes ≥28 lanes (≥31 with the build), and the 16 GB
host has headroom for 8. The two other routes are unfinished: skeleton-fed packets
should shorten the turn but have never been timed against a live harness, and the
scoping seat that would decide an edge-less file does not deserve a turn at all is
still unbuilt (Stage 1 point 4). So the design's honest cost is 105 turns and
~17 minutes, and closing the gap is outstanding work rather than a solved problem.

Worker-session hygiene is already solved on main
([#585](https://github.com/rbutera/rennet/issues/585), PR #590): utility and
swarm turns carry `SessionSpec.ephemeral`, which maps to the Claude Agent
SDK's `persistSession: false` and Codex's undocumented `thread/start`
`ephemeral` param (verified against codex-cli 0.147.0's generated schema —
re-verify on codex upgrades), so
neither CLI writes a transcript for those turns at all — proven by a live test
that counts files on disk (`ephemeral-session.real.test.ts`). The user's own
agentic sessions deliberately still persist, so `codex resume --last` stays
theirs. New swarm seats added by this plan must ride the same
`ephemeral: true` choke points (`codex-exec.ts`, `harness-run-turn.ts`)
rather than adding env redirects.

## Build order

1. **W1 — import-edge shard** (gates everything downstream).
2. **W2 — inventory classification + Louvain batching + neighborMap** (needs
   W1). Measure real batch counts on Rennet before W3.
3. **W3 — worker rewire** (skeleton-fed prompts, free exploration, journaled
   persistence) **+ deterministic merge + shrunken verify** (needs W2).
4. **W4 — refresh sharpening** (signature diff, file-level routing).
5. **W5 — consumption retrieval + un-hamstringing** (independent of W1–W4
   except the 1-hop retrieval, which wants W1; the lint-widening, cwd, and
   MCP fixes can land immediately).

Existing data is not migrated: the store's schema version advances and stale
sets are discarded (zero users; wiping `~/.rennet` is a legitimate answer).
Map quality remains a first-class result — if scoping or batching drops
something a reader needed, that is a finding against the approach, not a
rounding error on a speed win.
