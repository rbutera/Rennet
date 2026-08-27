---
title: Context assembly
description: How Rennet retrieves review evidence and answers selection-aware questions on demand.
---

Rennet does not hand a model a repository dump. Review context is assembled on
demand: the server resolves a query or the current review selection against
durable state and returns bounded, freshness-tagged evidence.

```mermaid
flowchart LR
  stores["Durable state<br/>patchset + Repo Map + ledger"]
  tools["Context tools<br/>targeted retrieval"]
  ask["Live ask flow<br/>selection-aware"]
  packet["Delta packet<br/>inlined drafter input"]
  answer["Answer<br/>evidence + freshness"]
  prompts["Drafting prompts"]

  stores --> tools --> answer
  stores --> ask --> answer
  stores --> packet --> prompts
```

## Repo Map context

The Repo Map provides two kinds of context:

| Layer | Source | Claims |
|---|---|---|
| Project snapshot | Deterministic repository processing at a pinned Git OID | Files, packages, symbols, entry points, dependencies, and identifier occurrences |
| Knowledge | Background model enrichment with evidence and provenance | Project purpose, conventions, relationships, and explanations |

The layers remain separate because a structural fact and a model-derived
explanation have different evidence and confidence. Freshness travels with both.

Multi-repository contexts compose member maps by reference. The workspace records
member identities, pinned OIDs, fingerprints, cross-repository edges, and
freshness without inlining each member's complete map into one prompt.

## Retrieval tools

The context tools read pinned project state and review provenance. Each tool has
a deterministic handler, so a caller cannot confuse a truncated answer with a
complete one.

| Group | Tools |
|---|---|
| Project context | `context.map`, `context.file`, `context.novelty`, `context.overview`, `context.symbol`, `context.references`, `context.knowledge`, `context.ask` |

Tool replies contain `data` and `freshness`. They add evidence, totals, cursors,
and truncation flags when the result requires them. Callers can page or narrow a
large query without confusing a truncated answer with a complete one.

`context.file` and the symbol tools read the pinned repository context.
`context.knowledge` returns evidence-backed project claims. Retrieval never
mutates review state.

## The Delta packet

Lens drafters do not retrieve their primary input through tools.
`buildDeltaPacket()` in `packages/core/src/delta/` assembles the drafters'
entire input from durable state: the hunk index with stable content-derived
ids, the element differ's output, blast-radius signals, deterministic noise
pre-classification, test-to-implementation counterpart hints, the knowledge
set, the bounded dossier, and — on re-review rounds — the successor account.
The packet is inlined into drafting prompts rather than fetched mid-draft, so
a drafter's evidence is pinned and reproducible. Facts that need the project
snapshot, such as ownership rules and fan-in, appear as explicit not-assessed
marks until dispatch supplies them, and openspec artifacts enter at path grain
with the full parse running where the artifact text lives. Raw payloads and
follow-up questions stay behind the context tools above.

## Selection-aware questions

`context.ask` is a live server operation. The UI sends the current review
selection through the session protocol. `packages/server/src/review-ask-live.ts`
resolves that selection against the immutable patchset, assembles bounded context,
and streams the answer back to subscribed clients.

Selection is an address, not prompt prose. The server resolves it to trusted
review state before constructing model context. This keeps a reconnecting desktop,
browser, or mobile client on the same review identity.

## Context budget

Retrieval moves from summary to detail:

1. Read identity, freshness, and available tools.
2. Retrieve a file, symbol, reference, or provenance record.
3. Narrow further when a reply reports truncation or a continuation cursor.
4. Answer from the retrieved evidence and state its freshness.

The server records the run in the ledger. This makes the retrieved context
inspectable without copying the entire conversation into durable state.

## Freshness behavior

Project and review identities are checked before the server labels retrieved
context current. A changed repository can make stored context stale while the
review's immutable patchset remains readable. Regeneration creates a successor
capture and rebuilt artifacts; it does not silently retarget the existing review.

See [Code intelligence](./code-intelligence.md) for the structural symbol tools
and [Architecture contracts](./architecture-contracts.md) for provenance and
freshness rules.
