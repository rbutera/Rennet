# Model Council

The Model Council is the deterministic subsystem that assigns each model-facing job a `(harness, model, effort)` before execution and writes an inspectable resolution trace. It is product behaviour, not hidden cost plumbing.

## Assignment rule

- **Deterministic:** a tool can be completely right; do not call a model.
- **Light:** all required code is already in the bounded input; use a schema-constrained, batched utility call.
- **Heavy:** the task must find or inspect additional code; use an agentic harness session.

Session riders share the model assigned to their parent heavy seat. The validator remains the admission authority; a cheap model can be used only where validation and bounded inputs make that honest.

## Resolver and budget

```text
job catalogue + availability + personal overrides
  → resolveAssignment() → RoutePlan → live budget gate → execution → resolution ledger
```

Resolution order is task override, tier override, council default for available harnesses, then harness default. Light-tier work may cross to another installed harness before collapsing tiers within one provider. Every run records why it chose its seat; the resolver never self-trains or changes its own defaults.

The live gate refuses a sixth initial invocation and counts retries. Initial decomposition must produce useful output in under 15 seconds. Never call a harness once per hunk.

## Job families

| Family | Examples |
|---|---|
| Deterministic floor | Git/patchset capture, lineage, decomposition limits/DAG, validation, canvas projection, prompt assembly, freshness, publication mechanics |
| Light/batched | Titles, requirement extraction, triage, relevance judgment, test mapping, narration, dedupe, refinement, handoff composition, PR prose, quick `context.ask` |
| Heavy/session | Decomposition proposal + riders, spec derivation, finding generation, anomaly spotting, comprehension ordering, orchestrator/chat, thorough `context.ask`, later independent adjudication |

## Current posture

The job catalogue, resolver, Codex utility seat, live RoutePlan integration, and resolution trace are implemented. The exact model defaults are versioned recommendations, not permanent code: users may pin a task/tier, and calibration can justify a table edit. Cross-provider disagreement is a future capability and must remain visibly degraded when only one provider is present.

## Calibration

Aggregate validator rejections by `(model, document type)`. A human changes the versioned assignment table when the evidence warrants it; no adaptive routing, bandit, or hidden feedback loop is permitted.
