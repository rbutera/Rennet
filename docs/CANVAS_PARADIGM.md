# Canvas paradigm

A **canvas** is the addressable, event-sourced projection of one review angle, scoped to `(reviewId, patchsetId, angle)`. It is not a drawing surface. Every element is anchored to code or a validator-admitted document, and every canvas can be rebuilt from the event store.

## Core model

Rennet has five canvases—spec, sequence, decisions, claims, and noise—and a blast-radius overlay that paints the others. `angle` names the analysis lens; `canvas` names its stateful surface instance.

| Layer | Owner | Rule |
|---|---|---|
| L0 substrate | Deterministic ingest | Read-only occurrences, chunks, requirements, and source identity. |
| L1 analysis | Validator + deterministic projector | Fleet agents emit documents; they never write a canvas. Project only admitted content with deterministic placement. |
| L2 dispositions | User | The only publish/handoff/read-state authority. No agent may write it. |
| L3 annotations | Orchestrator | Session-scoped highlights, callouts, links, and proposals; visually private and distinct; user pinning preserves a keeper. |

Logical cohort order derives from the dependency floor plus the comprehension-order contract. Canvas state carries patchset lineage: successors may carry exact approved elements forward, while ambiguity arrives unread.

## Actor partition

| Actor | May do | Must not do |
|---|---|---|
| Engine | Project admitted docs, invalidate, carry lineage, compute order | Expose internal state mutation as a model tool |
| Fleet | Emit structured review documents | Read, place, or alter canvases |
| Orchestrator | Describe, view, focus, annotate, propose, retrieve, request explicit recompute | Write L2, edit L1, publish, or access another review |
| User | Dispose, accept/edit/dismiss proposals, navigate, select/ask, pin/clear annotations | Have read state inferred from navigation |

A proposal is always L3 until a user accepts it. Focus is navigation, not read state. Regeneration remains an explicit, budget-gated user-visible act.

## Interaction contract

The orchestrator-facing `canvasOps@2` surface is MCP-shaped and versioned. It borrows MCP Apps' visibility and context-update grammar without embedding an iframe/UI layer: Rennet owns its renderer.

- `canvas.describe` gives count/cohort/element views with cursor and total.
- `canvas.view` gives the current open surface, expansion, viewport, and selection for deictic conversation.
- `canvas.read`, `canvas.thread`, `diff.read/search/structure`, `context.*`, and `run.*` retrieve evidence on demand.
- `canvas.focus`, `canvas.annotate`, and `canvas.propose` change only presentation/L3 state.

User selection, disposition, proposal adjudication, and viewing updates can be appended to the orchestrator's inspectable context stream. The detailed bootstrap/retrieval contract is [ORCHESTRATOR_CONTEXT.md](./ORCHESTRATOR_CONTEXT.md).

## Near-term rule

Build canvas state, deterministic placement, dispositions, L3 annotations/proposals, and the in-process tool surface as one coherent contract. Workspace-wide context composition, third-party-host canvases, and richer regroup/recompute affordances remain later work.
