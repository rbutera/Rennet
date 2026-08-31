---
title: Code intelligence
description: How Rennet resolves structural definitions, textual references, and import edges at the reviewed head OID.
---

Rennet's live code-intelligence path answers three review questions: where an
exported name is declared, where the same identifier text occurs, and which files
import which. It uses the deterministic Repo Map rather than a language server.

## Indexing and lookup

Project processing extracts three per-file shard families from supported
TypeScript and JavaScript files: structural symbols, textual identifier
references, and raw import specifiers. All three are tied to a pinned Git object
identity.

```mermaid
flowchart LR
  tree["Reviewed head tree"]
  extract["Repo Map extraction"]
  symbols["Structural symbol shards"]
  refs["Textual reference shards"]
  imports["Raw import-specifier shards"]
  server["Server symbol backend"]
  graph["Resolved import graph"]
  definition["context.symbol"]
  references["context.references"]

  tree --> extract
  extract --> symbols --> server
  extract --> refs --> server
  extract --> imports --> graph
  server --> definition
  server --> references
```

`packages/server/src/symbol-lookup-live.ts` builds the lookup backend for the
active review and pins it to the patchset's reviewed head OID. The result does not
include later uncommitted working-tree edits. `packages/server/src/dispatch.ts`
routes the protocol commands.

The symbol inspector combines:

- matching exported declarations;
- up to 200 textual identifier occurrences, with a truncation flag when more
  exist; and
- neighboring top-level symbols from the primary declaration's file.

The index uses content-addressed shards, so unchanged repository content can be
reused without changing its identity.

A snapshot that has been read and verified once is memoized for the life of the
daemon process, keyed on its manifest fingerprint — which covers every shard
digest — so a repeat lookup reads no shards at all. The accepted consequence: a
shard corrupted on disk *after* it verified is still served from that memo, and
the corruption surfaces at the next daemon start rather than at the next read.

## The import graph

Import shards record the raw specifiers a file names — `from '…'`, bare
`import '…'`, `require(…)`, and dynamic `import(…)` — with block comments stripped,
de-duplicated and sorted. They store specifiers rather than resolved paths, because
resolving a relative specifier needs the importing file's path, and a path inside
the shard would break the rename-and-copy reuse the other two families rely on.

Resolution into file-to-file edges happens on read, against the snapshot's own file
inventory and workspace scope table:

| Specifier | Resolves to |
|---|---|
| Relative (`./util`, `../a/b`) | The inventory file it names, trying plain extensions then a directory `index` file |
| Workspace (`@scope/pkg`, `@scope/pkg/sub`) | A file under the owning scope's root or source root; the most specific scope name wins |
| Anything else | Nothing. Node builtins, npm packages, and dangling paths contribute no edge |

The graph is file-to-file, so an unresolvable specifier is absent rather than
present as a node that is not a file. The raw specifier stays in the shard either
way. The extraction is textual, the same limit the other two families carry: a
specifier in a template literal or a line comment is recorded, and a computed
`import(variable)` is invisible.

Fan-in — how many other files depend on a changed file — has two possible sources,
and the code refuses to confuse them: an edge-backed count says files *import* the
changed file, a textual count says files *reference its symbols*, and the fan-in
index is a discriminated union, so the weaker method cannot be handed to a consumer
in the stronger one's shape. `fanInIndexFromSnapshot` builds that index from a
materialized snapshot, preferring the import graph and falling back to the
identifier-reference index when the snapshot has no import shards.

The Delta packet consumes it. When the composition root gates a fresh snapshot at
the patchset's base OID, `assembleRoundCollation()` builds the index and the blast
radius counts real dependents; the mark's own wording names the method that
answered, so a textual count never reads as a proven import edge.

The index is supplied only when the snapshot can genuinely answer the question. An
`import-edges` index is populated by construction. A `textual` one is withheld
unless the snapshot carries *both* the symbol and the identifier-occurrence shards,
because its lookup is a join across them and either half missing answers *zero
dependents* for every file — rendering as "checked, nothing depends on this".
Without an index the mark stays *not assessed* — never a silent zero.

Availability is also per file, because a populated index still cannot answer about
a path the base snapshot never carried. Fan-in is asked at the **base-side** path,
so a rename is counted where the file used to live; and an added file, or one the
snapshot's file cap never indexed, gets its own *not assessed* mark rather than a
zero. The repo-wide assessment stays true either way — this is one file the base
could not answer for, not the signal going dark.

## Mapping eligibility

Not every tracked file is worth a model's turn. Before the knowledge layer
batches anything, `classifyInventory` runs the same lockfile, vendored,
generated, and binary classifiers the changeset decomposer uses over the whole
snapshot inventory and reports a verdict per file.

| Reason | Signal |
|---|---|
| `binary` | A binary file extension |
| `lockfile` | A dependency lockfile basename (`pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) |
| `vendored` | A `node_modules`, `vendor`, `third_party`, `Pods`, … path segment |
| `generated-path` | A `dist`/`build`/`generated` segment, a `.min.js`/`.map` name, or a generator convention such as `.pb.go` |
| `generated-content` | A generator banner — `@generated`, `Code generated by …`, `DO NOT EDIT` — in the file's first ten lines |

An excluded file stays in the inventory. The map remains truthful about what the
tree holds; only the batcher acts on the verdict, so a reader who asks why
`dist/bundle.js` has no claims gets `generated-path` rather than silence.

Four of the five reasons are pure functions of the path. The banner check needs
the file's bytes, so it rides `SymbolShard.generated`, derived where the snapshot
generator already reads each blob once — an unchanged blob reuses the answer for
free, exactly like its symbols.

That shard family is emitted for every *path-eligible* text blob, not only the
ones the TypeScript/JavaScript extractor understands, so a generated `.py`,
`.sql`, or `.graphql` with a banner and no path signal is caught. A blob outside
the extractor's languages carries an empty symbol list and a real banner bit,
which keeps the whole classification in one per-blob family — one manifest
pointer array, one integrity walk, one incremental planner — instead of a fourth
family carrying a single bit.

What remains outside the check: a file the path rules already exclude is never
read for a banner, because content cannot overturn a verdict the path has already
made; and binary detection is an extension list, so an extensionless binary is
read as text and reports no banner. Both directions are safe — a missed banner
keeps a file in the map rather than dropping one that belongs there. The cost is
blob reads: a clean full build now reads every path-eligible file rather than
only the source files, which is why the clean build of Rennet below takes tens of
seconds. An incremental build reads only the changed closure.

## Module batching

The knowledge swarm's slices are shaped by the import graph, not by the directory
tree. `partitionsFromSnapshot` runs two tiers over the mapping-eligible files:

1. **Module batches.** Files with a resolved edge to another eligible file form an
   undirected weighted graph, and Louvain community detection groups them.
   Communities over 35 files split into near-equal chunks of their sorted paths;
   communities under 3 files pool with their scope's other leftovers, up to 25 per
   pooled batch. These communities, chunks, and pools are atomic inputs to a second
   deterministic pass. Within each most-specific workspace-root bucket, it
   greedily joins adjacent atoms up to 120 files; pure unscoped atoms share one
   sorted, repo-wide bucket. It never splits an atom or joins an atom whose members
   span roots. After final membership is known, the batcher rebuilds imports and
   cross-batch neighbors from the authoritative graph.
2. **The directory fallback.** Files with no import edge — documentation, config,
   assets, an unreferenced leaf — keep the original scope-and-subtree partitioner,
   and its slices are then coalesced. Adjacent slices within one workspace scope
   merge up to 160 files. All families outside workspace scopes share one sorted,
   repo-wide bucket; this can join top-level directories, but it never joins an
   unscoped file to a workspace scope. The partitioner alone left a long tail of
   small slices, and every one cost a worker turn. Merging never splits a source
   slice to fill a quota, and a slice already over the cap passes through as it is.
   The whole eligible inventory takes this tier when the import or symbol shards
   cannot be read: worse partitions, never a refusal to map. That degraded path is
   *not* coalesced — there the fallback already covers the different, whole-tree
   failure-mode population at a 120-file cap.

### Measured on Rennet itself

The #584 policy replay at `4d482fd8` covers 2,396 eligible files exactly once and
produces **48 candidate slices**:

| Tier | Slices | Largest | Measured composition |
|---|---:|---:|---|
| Module batches | 28 | 118 files | Eleven combine several atoms; the largest combines eight; each is wholly within one most-specific workspace root or wholly unscoped |
| Directory fallback | 20 | 159 files | Four unscoped packets mix top-level directories; the largest spans nine top-level directories and no workspace scope |

All 12 declared entry-point paths remain owned across 11 required slices. Final
module membership cuts 2,179 of 4,175 directed resolved relations, 52.19%, down
from 2,674, or 64.05%, before coalescing. This is snapshot evidence for the policy,
not a claim that every repository has the same counts.

Batching itself takes about 110 ms; the clean full snapshot build that feeds it
takes roughly 30 seconds, dominated by one blob read per path-eligible file.

#### The five-minute bar is not proved yet

The first clean 16-lane run at `4954bdd7` still used 111 worker turns and
disproved the earlier 34.7–37 second sample as a whole-run predictor. At 315.485
seconds, 88 workers had started, 72 had completed, none had failed, and the verify
seat had not begun. All 16 lanes started before the first terminal event and the
scheduler kept them full. The guard stopped the process group when pageouts grew
by 1,009; descendant RSS remained below the 4 GiB ceiling at 3,954,736 KiB,
ambient MCP and plugin-refresh process counts stayed zero, and the reap left no
survivors.

Those 72 completed workers took 61.048 seconds median and 61.055 seconds mean.
Their journals held 1,043 statements, 14.5 per worker on average. Statement count
tracked duration more closely than file count did (Pearson 0.770 versus 0.634),
with a fitted duration of roughly `8.36 + 3.638 × statements` seconds. That is a
correlation over a censored run, not proof that requesting less output causes the
whole saving.

The then-current statement-level merge over those preserved journals produced
879 residue entries (878 seams, four flagged statements, six verify chunks).
Keeping only each worker's first eight statements still left 439 entries and
three chunks. The cause was adjacency expansion rather than 439 distinct synthesis
questions: 267 of 283 cut-edge candidates in that prefix did not assert an import
relationship or name the neighbour, and only three of 341 hints resolved to a
concrete off-slice path.

The current repair combines two measured worker-phase changes with the
cut-endpoint-preserving verify reduction below. Each partition worker now ranks
and emits at most eight high-signal anchored hypotheses. The partition pass merges
pure-root module atoms up to 120 files and the graph-readable fallback tail up to
160 files. The exact replay above reduces the catalogue to 48 candidates without
omitting an eligible file or an atomic routing family.

The merge now represents that synthesis work once per source slice: every active
cut endpoint is retained, the worker's highest-ranked local statement starts the
reading, and at most one structured hint may name a concrete off-slice path and
explain the unresolved coupling. When that hint came from a lower-ranked statement,
the prompt includes that local source as well as the lead. Contradictions and delta
reverify items remain statement-level. Replaying that shape over the preserved
eight-statement prefix produced 44 cut groups plus three flags: **47 work items in
one 73,436-byte verify prompt**. It preserved all 241 canonical cut-edge pairs and
170 endpoint paths exactly. This is endpoint preservation, not prose preservation:
the verifier re-reads those paths instead of receiving every local worker claim.

The 64-slice scope contract separates candidate count from worker turns.
At 64 candidates or fewer, every slice runs and selection spends no model turn.
Above 64, one medium `map-scope@1` Council seat selects at most 64 whole slices
and accounts for every remaining candidate with a reason. The current guarded
proof snapshot has 48 candidates, so it launches all 48 workers in three 16-lane
waves and spends no selector turn. Selection still applies to a future catalogue
over 64; it never pretends the excluded files were mapped.

The shared stored knowledge schema and the verify seat's cross-cutting output
remain uncapped. The scope, worker, and verify contract uses generator
`knowledge-swarm@5`, so no `@4` or earlier stored set or journal answer can
satisfy it. Regrouped slice membership also changes the journal key. The earlier
worker fit projected about 37.5 seconds per turn. That projection now supplies a
proof hypothesis for the selected run, not a five-minute claim.

The launched evidence now says:

- **More lanes.** The old bare-path prompt took 78 seconds and would have needed
  29 concurrent workers, or 32 once the build was counted. The first real run at
  16 inherited every ambient MCP server per lane; swap grew by 5.19 GiB and
  pageouts advanced by 5,965 in 87.084 seconds. Codex workers now start with an
  explicit empty MCP policy rendered as disabled placeholders for every
  configured ambient entry, with plugin discovery disabled. A clean 24-lane
  control still reached 4,822,304 KiB (4.60 GiB) descendant RSS after 22.074
  seconds, with 24 workers active, zero ambient MCP or plugin-refresh processes,
  and no completed worker. The guard reaped the process group with zero survivors.
  That rejects 24 as the default. The complete 16-lane run stayed below the RSS
  ceiling but crossed the independent pageout guard after five minutes. Claude
  context-map seats likewise request the SDK's empty filesystem-setting sources
  and strict MCP mode; normal boards, lenses, scouts, and asks still inherit the
  user's Claude configuration.
- **Shorter turns.** The scoped eight-hypothesis worker schema attacks the term
  most correlated with measured duration. Its proof must report worker timing,
  statement yield, merge residue, verify timing, and whole-pass wall clock; a
  faster but materially empty map does not pass.
- **Fewer turns.** Same-scope module atoms and the graph-readable fallback tail
  coalesce without omitting a file or routing family. The current 48-slice
  catalogue runs whole. `map-scope@1` still caps a future larger catalogue at 64
  selected whole slices, and stored coverage records every exclusion.

The current snapshot costs **48 worker turns and no scope-selection turn**. The
general contract remains one scope selection, with at most two attempts, plus at
most 64 worker turns when a catalogue exceeds 64. The release proof is a complete
guarded `knowledge-swarm@5` run; candidate count alone does not establish the
whole-pass latency or memory bar.

Batching is deterministic end to end. Louvain runs with its randomisation
disabled, over nodes and edges inserted in sorted order, so the same snapshot
always yields the same batches in the same order.

A batch's id is `mod:<lexically-first member path>#<hash>`, where the hash covers
the batch's sorted member paths. It is a pure function of the batch's content, not
of Louvain's community numbering, which is an artifact of iteration order and
means nothing across builds. A module batch that combines several atoms retains
every constituent atom's routing family. A deleted file owned by a non-head atom
therefore reaches the combined successor even though only the first family appears
in its id.

A coalesced fallback slice follows the same rule with a different first half: the
hierarchical id of its first constituent, plus `#<hash>` over the merged
membership. Keeping the hierarchical half means the fallback tier's routing family
is unchanged by coalescing — a delta reaches a merged slice by the same directory
prefix it used before. A fallback slice that merged with nothing keeps its bare
hierarchical id and no hash. Every constituent family is retained explicitly, so
a deletion under a non-head directory still routes the merged successor.

### The neighbor map

Batching cuts edges, and a worker that saw only its own files would read a module
as if those edges did not exist. Each batch therefore carries, per member, its
one-hop import neighbours *outside* the batch: the neighbour's path, whether the
member imports it, is imported by it, or both, and the neighbour's exported symbol
names joined from the symbol shards.

The batcher computes this map after final coalescing. An edge between two atoms
that merged becomes an internal `imports` entry, not a stale cross-batch neighbor.

The list is capped at 50 neighbours per file, keeping the highest-degree ones, and
records how many were dropped. A hub's neighbourhood is genuinely larger than what
is shown, and a worker that is told so can go and read the rest.

## Confidence

The response labels what the index actually proved:

| Result | Confidence | Meaning |
|---|---|---|
| One exported declaration | Exact, structural | One declaration with that exported name exists in the structural index |
| Several exported declarations | Guess, structural | The name alone leaves several candidates |
| Identifier occurrences | Guess, textual | The same identifier text appears at these sites |
| Missing or unreadable shard | Unavailable | The index cannot answer from the pinned data |

"Exact" is scoped to the structural index. It does not mean type-aware symbol
resolution. Textual references can include an unrelated name from another scope
and can miss a relationship that does not preserve the identifier text.

## Review integration

Review context reaches the same backend through `context.symbol` and
`context.references`. Responses carry freshness, evidence, totals, and
truncation where applicable. The UI symbol
inspector presents the definition candidates, references, and file neighbors
without upgrading textual evidence to semantic certainty.

The pinned head tree covers committed code in the reviewed patchset. Diff tools
remain the authority for staged, unstaged, and untracked changes captured on top
of that tree.

## The knowledge layer

Beside the structural index, the Repo Map stores model-generated knowledge
claims. `packages/core/src/knowledge/` generates them as a partitioned swarm:
[module batching](#module-batching) slices the snapshot so every mapping-eligible
file lands in exactly one candidate slice. A scope pass selects whole slices, a
light `partition-worker` Council job emits anchored claims for each selected
slice, a deterministic merge combines them, and a `map-verify` seat handles what
the merge could not settle. All three model jobs resolve through the
[Model Council](./model-council.md). Claims that fail anchor resolution are
dropped at mint time, so a stored claim always cites spans that resolve against
the snapshot.

### Scope selection and exact coverage

`map-scope@1` owns selection before workers start. Its cap is 64 slices.

- With 64 or fewer candidates, the selector includes every slice
  deterministically and runs no model turn.
- With more than 64 candidates, one medium Council seat receives the classified
  candidate catalogue. It must return an exact partition: every offered slice id
  appears once in either `include` or `exclude`, between one and 64 slices are
  included, and every exclusion has a nonblank reason. A slice that contains a
  declared entry point must be included.
- The selection catalogue carries every slice id and member path, routing
  families, entry-point and test membership, structural counts, and a bounded
  sample of cross-slice paths. Full symbol skeletons, import-edge pairs, and
  neighbour export names belong to selected workers; duplicating those packets in
  the selector can overflow the scope turn before the 64-slice cap applies.
- Selection is whole-slice only. The seat chooses trusted slice ids and never
  supplies or edits file membership. Invalid, partial, repeated, or unknown
  selections retry once, then fail the run before any worker starts.

The promoted `knowledge-swarm@5` set stores this decision as exact coverage.
Flattening its coverage groups yields every `(path, blobOid)` in the structural
snapshot exactly once. Each group is one of:

- a mapped slice;
- a slice excluded by `map-scope`, with its reason; or
- files excluded mechanically as binary, lockfile, vendored, generated by path,
  or generated by content.

The coverage record carries the catalogue digest and distinguishes deterministic
below-cap selection from a Council turn. A Council selector records the cap,
generator, harness, assigned and observed model, effort, and credential source.
The coverage record is stored atomically with the statements. An older set with
no coverage remains readable as legacy data, but it cannot serve as carry input
for an `@5` refresh because absence never means every file was mapped.

On a baseline advance, selected slices whose structure changed run as usual.
Slices that become newly selected also run, even when file routing would otherwise
carry them. A claim whose evidence moves outside mapped coverage retires whole;
claims from unchanged selected slices carry forward byte for byte.

### What a worker is given

A worker's prompt is not a path list. Per batch it carries each member file's
symbol skeleton — declared names, kinds, and 1-based lines, straight from the
symbol shards — the batch's own resolved import edges, and the neighbor map: the
edges batching cut, with each neighbour's direction and exported names.

The packet distinguishes three states a file can be in, because they are three
different facts: a file with symbols shows them; a file the extractor indexed and
found nothing in says so; a file with no symbol shard at all says *that*. A `.md`
gets the second line, not an empty structure that could be misread as "this file
declares nothing worth citing". A fallback slice, which by definition has no
resolved edges, gets an honest reduced packet rather than a fabricated one — and
if the import graph could not be read at all, the packet says the graph was
unreadable rather than reporting no edges.

The worker's working directory is the repository checkout and it is free to read
any of it. The skeleton is where it starts, not where it stops: reading is
targeted, not forbidden, and reconstructing a *why* usually needs the source. The
saving comes from better inputs, not from denying a capable seat its tools. The
anchor-or-drop rule is unchanged and is what keeps that freedom honest — a
citation that does not resolve against the slice's own file index is dropped at
mint.

One worker emits at most eight statements, ranked highest-signal first. This is a
ceiling on pre-merge hypotheses from one slice, not a cap on the stored knowledge
set or on the verify seat's cross-cutting synthesis; both of those schemas remain
uncapped. Rennet does not silently truncate a longer returned array. The provider
receives the scoped schema, and the measured proof checks the resulting journals
against the ceiling.

### The deterministic merge

A script, not a seat, combines the workers' output. It collapses duplicate
statement ids; collapses the same claim minted over different evidence, keeping
the better-anchored one (more anchors, then more line spans, then the smaller id
— deterministic to the bottom, so two runs of one swarm merge identically); and
checks every import-shaped claim against the authoritative edge shard. A claim
that asserts an import between two files it *names or cites*, where no resolved
edge joins any pair of them, is *flagged* — never deleted and never rewritten.
The import index is textual, so a computed import looks exactly like a false
claim, and silently editing a model's words would be worse than either. A claim
whose second endpoint is neither written down nor cited stays a hypothesis: there
is nothing to cross-check it against, and nothing a seat could adjudicate either.

The merge never mints. Every surviving statement keeps its worker's provenance
byte for byte.

### What the verify seat is left

The seat receives only the merge's residue:

- **Seam groups.** One synthesis item per source slice, not one item per local
  statement. The group retains every cut import endpoint whose far side another
  slice wrote about and starts from the source worker's highest-ranked statement.
  Cut edges come from the whole import graph, not the packets' capped neighbour
  lists, so a hub file's later neighbours remain visible. Groups are built from
  pre-dedupe worker origins, so two workers wording the same claim cannot erase
  either source slice's boundary.

  Import edges cannot describe a shared convention, runtime registration, or
  protocol implemented without a direct import. The escape hatch is one structured
  `{ path, coupling }` hint per group. The worker boundary admits it only when the
  path exists in the repository, lies outside that slice, and the coupling is
  non-empty. A vague "elsewhere" hint does not become synthesis work.
- **Flagged statements.** The edge-shard contradictions above, plus a delta's
  prior statements whose cited evidence changed — unsettleable by script, because
  the bytes moved. These remain statement-level verdict requests. Seam-group leads
  are synthesis-only, and an unsolicited verdict for one is ignored.

The earlier statement-level benchmark on Rennet's 105 slices produced 877 entries
from a dense stand-in and 192 from a lower-density one. The later launched journals
showed that density was not the governing quantity: the eight-statement prefix
still produced 439 statement entries, while the equivalent source-slice grouping
produced 47 work items and one 73,436-byte chunk. An empty residue still runs no
turn at all — with no seam group and no contradiction there is nothing to synthesize from.

The residue is still chunked (150 work items per turn, several in flight) as a
ceiling rather than an expectation, and the pass is still all-or-nothing: one
failed chunk fails the run and leaves the stored set untouched, rather than
publishing an unadjudicated slice of the repository as if the seat had read it.

Chunking bounds what one turn can synthesize, so a final cross-boundary pass runs
over the chunks' own output. It selects candidates round-robin by source chunk up
to one verify-chunk ceiling, preventing one prolific early chunk from hiding every
later chunk, and carries a one-line summary of every chunk into the closing turn.
That input is bounded independently of the number of stored statements. The pass
is best-effort — if the closing turn fails, the run keeps its chunk-local synthesis
rather than discarding a good map over a bonus turn.

One residual: the closing turn reads the chunks' claims, not their raw
hypotheses, so a pattern that only becomes visible in two individual hypotheses
on opposite sides of a boundary can still be missed. Cross-cutting coverage is
therefore near-repository-wide rather than exhaustive.

### Persistence: the journal

Each completed selected batch writes its result to a **journal**, a directory
beside `knowledge/` in the project's reserved store, never inside it, that no
reader consults. A re-run at the same target reuses those results instead of
re-running their turns, so a retry pays only for what actually failed. Narration
says `reused from the journal` rather than `done`, because no turn was spent.

For a catalogue above 64 slices, the same target also stores `scope-plan.json`
before any workers start. The plan binds the full candidate catalogue and its
digest, the 64-slice cap, `map-scope@1`, the selected and excluded slice ids, and
the Council's harness, model, and effort to a checksum. A retry reuses that exact
plan. It does not spend another selection turn or let a changed model answer send
the retry to a different set of workers.

A *target* is the base OID, the snapshot fingerprint, the generator id, the slice
id, and the slice's exact membership. All five: a re-extraction or a prompt
rework at an unchanged git OID is a different question, and the old answer is not
an answer to it. A journaled record also carries a checksum over the worker
result, and on read every statement id is recomputed from its content, every
`learnedAgainst` must name this target, and every anchor must resolve against the
slice's membership at its current blob. Anything that does not survive those
checks reads as "not journaled", which costs one re-run turn — the cheap side of
the trade against a damaged statement entering a set.

Every selected batch runs; failures are retried once after the rest have
finished. If a batch still fails, the run reports **which** slices failed and how
many selected batches are waiting for the next attempt. The store rule is the
point of keeping the two places apart: the live `knowledge.json` is written once,
when the selected plan is whole and its exact coverage can be stored beside it. A
partial set never presents as complete, however much of it is journaled.

The journal is one directory **per target** — named for a hash of the base OID,
the snapshot fingerprint and the generator id together, not for the OID alone,
since a re-extraction and a prompt rework at one OID are different questions and
sharing a directory would let either one's promotion clear the other's completed
turns. A promotion clears only its own directory, plus any target directory
untouched for a day. Two runs can be in flight at once
— the background watcher is single-flight with itself, but the review-open
knowledge kick is not coordinated with it — and a recursive clear would let the
first to promote destroy the other's completed turns. For the same reason the
store write re-reads the store's identity first: a run whose prior moved
underneath it refuses to save, reports **superseded**, and keeps its journal so
the retry costs no turns.

Worker fan-out uses a named, harness-specific default after council resolution:
16 for Codex partition workers, whose job-scoped empty policy expands into
disabled placeholders for the configured ambient entries, and 12 for Claude
partition workers. A caller's explicit per-run limit wins. The policy is
deliberately not adaptive: ambient load does not change the recorded run policy.

Verify concurrency stays at 4 by a separate policy. W3 changed that pass from a
second fan-out over every worker statement to a residue-only pass, normally one
or two chunks with larger prompts and cited-span reads. Raising its bound would
not raise worker throughput or alter the partition-worker policy.

The first pass is part of the awaited add-project run: readiness, the sidebar
spinner, and the verified statement counts all wait for its typed outcome. Later
baseline enrichment runs in the background and reports its outcome — including
the reason it skipped or failed — on the project's build timeline, under a
progress id keyed to that project so one project's work never appears on
another's. A failure that arrives as a thrown error is converted to the same
typed outcome and narrated on the same line as a reported one. The client retains
a project's background narration above the screen that shows it, so a failure
that happened while the reader was elsewhere is still there when they open the
project — a run is never silently absent, and never visible only to whoever was
watching.

### Refresh: what a change costs

Content addressing already answers *unchanged* for free — a blob whose OID did not
move is never re-extracted and never re-mapped. What is left is the changed set,
and most of it is body churn: a rewritten function, an added branch, a fixed
comment. None of that alters what a file **exports**, which is the skeleton its
worker was fed and what its statements are about.

So the changed set is split before it reaches routing. Each changed path is
compared across the two snapshots' per-blob shards on three terms: the exported
symbols by name and kind, the generated-banner bit, and the **raw import
specifiers** the file names. Line numbers are deliberately excluded, because
everything below an inserted line moves and says nothing about structure. A file
whose signature is identical on all three is **cosmetic** and routes no worker;
anything else is **structural** and routes as it always did. A slice re-runs when
at least one of its changed members is structural, so routing is file-level rather
than partition-level, and the run reports how many slices it skipped for being
structurally unchanged.

Imports are in the signature because they decide something the export surface
cannot see. An import-only edit leaves every exported name and kind exactly where
it was while changing the file's partition membership, its module batch's cut
edges, and the neighbour map its worker reads — so on exports alone it classified
cosmetic and routed nothing, and the map went on describing a graph the repository
had left.

The whole comparison has a precondition: **two comparable snapshots**. A snapshot
is identified by its fingerprint, not by its base OID — a manifest is stored per
baseline and overwritten in place, so a re-extraction replaces the view the stored
statements were learned against while the OID stays put. The pass joins the prior
snapshot on the fingerprint the knowledge set records; without a match, or without
a readable prior at all, there is nothing to compare and the whole change is
structural.

Every "we cannot tell" lands on structural, because a needless turn is the cheap
error and a skipped one is invisible:

| case | verdict |
| --- | --- |
| no readable prior snapshot — never built, corrupt, or evicted past the 32-manifest retention window | *everything* structural |
| a prior snapshot whose fingerprint is not the learned-against one | *everything* structural |
| added or deleted | structural |
| same blob on both sides | cosmetic |
| a language the symbol extractor does not read | structural |
| a shard missing, unreadable, or about a different blob, on either side | structural |
| the two sides produced by different extractors | structural |
| the generated-banner bit moved | structural |
| a symbol added, removed, renamed, or re-kinded | structural |
| an import specifier added, removed, or re-pointed | structural |
| identical symbols and imports, different lines or bodies | cosmetic |

The first two rows are whole-run rather than per-file: they are decided once,
before any path is examined, and every changed path is structural at a stroke.

Which statements re-verify is a separate question from which slices re-run, and
the split governs only the second. Re-anchoring keys on the blob moving, so a
body-only edit re-stamps every statement anchored in that file and sends it to the
verify seat flagged — conflating the two would leave claims anchored to bytes that
no longer exist.

Re-anchoring is not free of consequence for the statement, though. A moved anchor
keeps its path and its cited symbol name but **loses its line span**: a cosmetic
edit is exactly the edit that shifts every line below it, so the old span would
point at the wrong code under the new blob, and the verify seat renders that span
as the place to look. So the flagged entry says the span was dropped, and the seat
re-reads the file rather than trusting a range. Precision is traded for not being
wrong, and it is recovered the moment a seat looks.

Two ceilings, both structural to the approach rather than bugs in it:

- **Exports only.** The extractor reads top-level exported declarations, so a
  rewritten private helper reads as cosmetic — including every edit to a file that
  exports nothing at all, which is most test files. That is the right answer for
  what a statement about the file's surface can assert, and the wrong answer for a
  claim about an internal mechanism. Such a claim's anchors still moved, so it is
  re-anchored and flagged; what is genuinely lost is the chance to *mint* a new
  statement about the internal change. Widening that needs a deeper extractor, not
  a finer diff.
- **TypeScript and JavaScript only.** Every other file gets a shard carrying
  `symbols: []`, which is indistinguishable from an unchanged TS file with no
  exports, and no import shard at all — so a markdown, JSON, Python or SQL edit is
  classified structural and re-runs its slice's worker rather than being guessed at.

**Measured on Rennet's last 100 non-merge commits** (457 changed files, using the
same `structural-ts-v2` extractor the shard family runs): 245 files (54%)
classify as cosmetic, and **17 of the 100 commits would route zero slices** — a
baseline advance for **zero worker turns**. 114 of those 245 are files with an
empty signature on both sides, 105 of them test files; excluding those, 131 files
(29%) are real export surfaces that a commit touched without moving. The figure
counts files and whole commits, not slices: a commit with one structural file
still runs whichever slices own it.

Two things that figure does not say. It was measured on the export surface alone,
**before imports joined the signature**, and an import specifier can only move a
file from cosmetic to structural — so read 54% and 17 as an upper bound on the
current classifier, not as its output.

And zero *worker* turns is not zero turns. Every statement anchored in an edited
file is re-anchored and reaches the verify seat flagged, and that residue runs the
verify turn even when no worker did — only a commit whose changed files carry no
statements at all runs nothing whatsoever. That turn is not overhead; it is the
mitigation the exports-only ceiling leans on. A claim about a rewritten private
helper is exactly what the signature diff cannot see, and the verify seat re-reading
it is what stops the saving from becoming a stale map.

## Current scope

The live index does not provide type-directed references, rename analysis,
call-hierarchy resolution, inferred types, or compiler diagnostics. Those
questions require different evidence than the current structural and textual
shards provide, so the UI reports the narrower result rather than presenting it
as language-service output.

See [Context assembly](./context-assembly.md) for retrieval and freshness and
[Architecture contracts](./architecture-contracts.md) for Repo Map identity.
