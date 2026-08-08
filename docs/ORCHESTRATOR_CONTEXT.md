# Orchestrator context

The orchestrator receives a **map of the review, not a dump of it**. Bulk context becomes stale and a fixed cap guesses wrong; durable canvases, patchsets, and project snapshots are queryable state. Retrieval is therefore the orchestrator's zoom mechanism.

## Bootstrap

The deterministic, versioned bootstrap is intentionally small and inspectable. It contains:

1. Review/repository identity, patchset lineage position, and mode.
2. Per-repository freshness verdicts.
3. Count-level canvas state and residue/disposition coverage.
4. A short protocol card: actor limits, logical order, roll-up/zoom, and how to ask.
5. Tool index and current run-ledger headline.

It never inlines full diffs, snapshot shards, RSP bodies, disposition threads, knowledge, or full provenance. Its digest belongs in session provenance.

## `canvasOps@2` retrieval contract

All retrieval tools are read-only and return `{data, evidence, freshness, total/cursor, truncated?}`. A cursor is never the whole result; `nothing found` is distinguishable from a failed call; stale data is marked at reply time.

| Bucket | Operations |
|---|---|
| Canvas | `canvas.describe`, `canvas.view`, `canvas.read`, `canvas.thread` |
| Diff | `diff.read`, `diff.search`, `diff.structure` |
| Base/workspace context | `context.map`, `context.file`, `context.knowledge`, `context.ask` |
| Provenance | `run.ledger`, `run.provenance` |

The tool surface contains no L2 write, L1 edit, publish, cross-review read, or hidden recompute operation. `canvas.recompute` is a separately visible, budget-gated escalation.

## `context.ask`

`context.ask(question, scope?, budgetHint?)` is the only interface to the background knowledge agent. It returns a validated, evidence-cited answer with confidence and an explicit `unanswered` outcome where appropriate. The implementation may start with deterministic composition plus light-tier synthesis and later evolve to a warm sub-agent without changing the orchestrator's contract.

The knowledge worker has read-only access to snapshots, evidence-backed knowledge, base-ref files, admitted documents, and occurrence manifests. It has no canvas write access, no user-view state, and no conversation history beyond the question. Spend is accounted in the run ledger.

## Empirical requirements

Before treating the design as proven, measure: map vs dump/cap correctness and context cost; `context.ask` answer/evidence/refusal quality; synchronous latency; whether the orchestrator asks when it should; and warm-session/tool-schema economics across harnesses. Until then, keep the contract stable and the implementation honest.
