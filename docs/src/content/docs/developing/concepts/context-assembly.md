---
title: Context assembly
description: How Rennet gives the orchestrator a small map of the review and lets it retrieve fresh detail on demand.
---

The orchestrator starts with orientation, not a dump of the repository. Rennet
keeps the durable context queryable and gives the orchestrator a compact map plus
tools for zooming into exactly what the conversation needs.

## Map, then retrieve

Dumping the diff, Repo Map, every finding, and every disposition into the opening
prompt wastes the conversation window and goes stale. Picking an arbitrary slice
up front merely hides a different set of useful facts.

Rennet instead treats its stores as the context:

```mermaid
flowchart LR
  stores["Durable review state<br/>Repo Map · patchset · canvases · run ledger"]
  primer["Lean primer<br/>identity · freshness · counts · protocol card"]
  session["Orchestrator session"]
  tools["canvasOps@2<br/>retrieve at the needed altitude"]
  answer["Grounded answer<br/>with evidence and freshness"]

  stores --> primer --> session
  stores --> tools --> session --> answer
```

This is Rennet's roll-up and zoom idea pointed inward. The orchestrator can start
with canvas counts, expand to cohorts, inspect one element, then read the hunk or
base-branch symbol beneath it.

## The Repo Map

The user-facing **Repo Map** has two deliberately different layers:

- The deterministic snapshot records files, packages, symbols, dependencies,
  entry points, references, and ownership against a pinned base OID.
- The knowledge layer records model-derived explanations and evidence. It keeps
  provenance and confidence because “why this module exists” is not the same kind
  of fact as “this symbol is exported here.”

Multi-repo workspaces compose repo maps by reference. A workspace context names
member identities, pinned OIDs, fingerprints, cross-repo edges, and freshness;
it does not inline every child map into one enormous document.

## What the primer carries

The primer is deterministic, versioned, byte-bounded, and recorded by digest in
the session provenance. It contains six small sections:

| Section | Contents |
|---|---|
| Identity | Workspace or repo, review, patchset, lineage position, and mode |
| Freshness | One verdict per repo snapshot |
| Canvas summary | Counts, cohorts, disposition coverage, and residue — no bodies |
| Protocol card | How the session works and when to retrieve |
| Tool index | Names and one-line “use this when” descriptions from the live registry |
| Run headline | Tasks run, documents admitted/rejected, and budget summary |

The tool index is derived from `CANVAS_OPS_TOOLS`, so adding a registered tool
updates the menu the orchestrator sees. The full schemas stay on the MCP surface;
they do not all have to live in the opening prompt.

## The live `canvasOps@2` surface

The current registry groups naturally by what it reads or changes:

| Area | Tools |
|---|---|
| Canvas interaction | `canvas.describe`, `canvas.view`, `canvas.focus`, `canvas.annotate`, `canvas.propose`, `canvas.recompute` |
| Canvas retrieval | `canvas.read`, `canvas.thread` |
| Changed code | `diff.read`, `diff.search`, `diff.structure` |
| Run evidence | `run.ledger`, `run.provenance` |
| Repo Map | `context.map`, `context.file`, `context.overview`, `context.symbol`, `context.references` |
| Derived context | `context.novelty`, `context.knowledge` |

Each reply uses one envelope:

```ts
{
  data: unknown,
  evidence?: string[],
  freshness: 'current' | 'updating' | 'stale' | 'failed',
  total?: number,
  cursor?: string | null,
  truncated?: { droppedBytes: number }
}
```

Lists report totals and cursors, and a query with no matches reports an empty
result explicitly. Freshness travels on the answer itself, which matters when a
base branch advances halfway through a long review.

## View context: contract and current gap

The session model can accept structured selection, disposition, proposal, and
view events. The live renderer does not push that stream into the orchestrator
yet. `canvas.view` currently returns a static view with no expanded cohorts or
selection, and the live turn sends the raw question rather than a request built
from the session's pushed context.

```mermaid
sequenceDiagram
  participant U as Reviewer
  participant C as Canvas UI
  participant S as Context update stream
  participant O as Orchestrator
  participant T as canvasOps@2

  U->>C: Select a decision and ask “why?”
  C->>S: selected + current view
  S->>O: Question with structured deixis
  O->>T: canvas.read(decision)
  O->>T: diff.read(anchor)
  T-->>O: Evidence + freshness
  O-->>U: Answer about the selected decision
```

The diagram is the intended wiring. The session can produce an assembled-prompt
object internally, but that view is not exposed through the current UI or IPC.
Until the wiring lands, phrases such as “this decision” need explicit anchors in
the question rather than relying on invisible renderer state.

## The `context.ask` seam

The design includes a synthesis tool named `context.ask`: one stable request and
answer shape, with any retrieval sub-agent hidden behind it. That keeps the
orchestrator contract independent of how Rennet later implements deeper answers.

It is **not registered on the current live `canvasOps@2` surface**. The primer's
protocol-card text still mentions it, while the live tool index does not. Treat
that as an implementation seam, not a callable capability. Today the
orchestrator uses deterministic retrieval. The `context.knowledge` tool shape
exists, but the persistent model-derived knowledge layer is not composed into
desktop main; a background answer agent and its `answer` document are deferred.

The live tracking item is [#15 — context.ask](https://github.com/rbutera/rennet/issues/15).

## Code map

| Concern | Source |
|---|---|
| Primer and protocol card | `packages/core/src/orchestrator-primer.ts` |
| Tool registry and envelopes | `packages/core/src/canvas-ops.ts` |
| Session assembly | `packages/core/src/orchestrator-session.ts` |
| View and interaction event stream | `packages/core/src/context-update-stream.ts` |
| Repo snapshot reads | `packages/core/src/project-context.ts` |
| Workspace composition | `packages/core/src/repo-composition.ts` |

See [the canvas model](/developing/concepts/canvas-model/) for the surfaces being
retrieved and [the Model Council](/developing/concepts/model-council/) for how
model-backed context work gets a seat.
