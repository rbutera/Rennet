## Why

No model is selected anywhere in merged code. `runDecompositionAngle` and `runOrderingPass` take a caller-supplied `model` string in their provenance seed and never decide it; the three assignment tables in `docs/Rennet Model Council.md` exist only as prose. And the budget ceiling that makes the money shape safe is dead: `buildRoutePlan` (the Brita filter) is merged with zero non-test callers except the pipeline's pre-flight refusal, and even that pre-flight count never sees the retries inside each runner or the ordering pass — so a decomposition that fails and retries twice, then runs ordering with its own two retries, can issue up to six model turns while the plan counted three. R10's <5-invocation ceiling is money, and money is a vital circuit: it must be enforced at runtime, not asserted once in a CI test (bead p0wwp).

This slice gives the Model Council a body: the versioned job catalogue, the deterministic `resolveAssignment` resolver, the live runtime budget gate that counts every actual invocation including retries, and the resolution-trace ledger that can always answer "why did this job run on that model."

## What Changes

- Add the Model Council types to `packages/types`: the model set (`CouncilModel`: Haiku / Sonnet 5 / Opus 4.8 / GPT-5.5 / 5.6-Sol / 5.6-Terra / 5.6-Luna), `CouncilEffort` (low/medium/high/xhigh), `CouncilTier` (light/heavy/deterministic), `CouncilScenario` (both/claude-only/codex-only), the job catalogue entry shape, the override shape (`routing.task.*` / `routing.tier.*`), the `CouncilResolution` result, and the structured `ResolutionTrace`.
- Add `packages/core/src/model-council.ts`: the versioned `JOB_CATALOGUE` (every model-facing job -> tier, batching shape, session-rider flag) plus the three availability-default assignment tables from Model Council §3, shipped versioned like a schema; and `resolveAssignment(jobId, ctx)` — a pure, deterministic function returning `{ harness, model, effort, trace }` in the resolution order task-override -> tier-override -> council default table (keyed by availability scenario) -> harness default. Cross-harness routing (R39) is baked into Table 1: light-tier work resolves to a different installed harness than the review sessions, preferred over tier collapse. Deterministic-tier jobs resolve to a `deterministic` result (no model).
- Add `packages/core/src/invocation-budget.ts`: `createInvocationBudget(max)` — a stateful shared counter whose `tryConsume(purpose)` grants or refuses one invocation, so retries decrement the same budget and a 6th invocation is refused at runtime with a typed refusal (`R10_BUDGET_EXHAUSTED`).
- Wire the budget onto the LIVE path: `runDecompositionAngle` and `runOrderingPass` consult the injected budget before EVERY `runTurn` (the first attempt and every retry). A refusal is a typed, fail-closed outcome — the runner records a `budget-refused` attempt and falls to the deterministic floor; no crash, no silent skip. `buildReviewCanvases` creates ONE shared budget seeded from `maxHarnessInvocations` and threads it through both runners, so the whole decomposition-plus-ordering phase draws from a single ceiling. The pre-flight `buildRoutePlan` refusal stays (build-time drift catch); the live budget is what makes the ceiling real.
- Wire model selection into the pipeline: when a `council` context (availability + overrides) is supplied, `buildReviewCanvases` calls `resolveAssignment` for the `decomposition-proposal` and `comprehension-ordering` jobs and stamps the resolved `{ model, effort, resolutionTrace }` into each phase's provenance. `RspProvenance` gains optional `effort` and `resolutionTrace` fields (both `.loose()`-compatible; existing documents validate unchanged).

## Capabilities

### New Capabilities

- `model-council`: the versioned job catalogue, the three availability-default assignment tables, and the pure deterministic `resolveAssignment` resolver with its resolution order, R39 cross-harness routing, and structured resolution trace.
- `invocation-budget-gate`: the shared stateful runtime budget whose `tryConsume` counts every invocation including retries and refuses over the ceiling with a typed refusal — the live enforcement of R10 (fixes p0wwp).

### Modified Capabilities

- `decomposition-angle-generation`: `runDecompositionAngle` accepts an optional injected invocation budget and consults it before every turn (including retries); a refusal falls to the deterministic floor. Behaviour is unchanged when no budget is injected.
- `comprehension-ordering-pass`: `runOrderingPass` accepts the same optional injected budget with the same semantics.
- `review-pipeline`: `buildReviewCanvases` seeds one shared budget from `maxHarnessInvocations` and threads it through both runners; when a council context is supplied it resolves the per-phase model assignment and stamps `{ model, effort, resolutionTrace }` into provenance.

## Impact

- Adds `packages/core/src/model-council.ts` and `packages/core/src/invocation-budget.ts` (re-exported, colocated-tested). Extends `packages/types/src/index.ts` (new council + budget types; two optional provenance fields) and `packages/protocol/src/rsp.ts` (two optional provenance schema fields under the existing `.loose()` object — no digest change, no rejection of existing documents). Extends `packages/core/src/{angle-generation,ordering-pass,pipeline}.ts`.
- No new package, no new external dependency, no dependency-arrow change: the architecture and licenses gates are untouched. The council is pure data + pure functions; the budget is a pure closure.
- The `CodexUtilityPort` (#66) is NOT built here; the resolver only NAMES a Codex seat (via the model's provider -> harness). The seat abstraction is kept clean so #66 wires the real `codex exec` execution as the first alternate seat in a follow-on slice.
- Out of scope: the settings UI keys (#28) — the override shape is supported by construction so #28 attaches without a core change; the calibration read (M27 / documentRejected aggregation) — the council never self-mutates.
