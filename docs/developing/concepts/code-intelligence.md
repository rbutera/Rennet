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

## Current scope

Code intelligence is deterministic end to end. Every fact above comes from
reading the pinned tree — no model turn produces or reviews a shard, and the
Repo Map stores no model-generated claims about the repository.

The live index does not provide type-directed references, rename analysis,
call-hierarchy resolution, inferred types, or compiler diagnostics. Those
questions require different evidence than the current structural and textual
shards provide, so the UI reports the narrower result rather than presenting it
as language-service output.

Nothing here tries to explain the repository, either. Explanation is the
reviewing agent's job: a lens drafter runs as a harness agent inside the
reviewed checkout with the tools it would have anyway — `git`, file reads,
search — and investigates the change directly. The index gives it a fast
structural answer when it wants one; it does not stand in for reading the code.

See [Context assembly](./context-assembly.md) for retrieval and freshness,
[Lens pipeline](./lens-pipeline.md) for how a drafter investigates a change, and
[Architecture contracts](./architecture-contracts.md) for Repo Map identity.
