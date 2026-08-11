## 1. Shared types (types)

- [x] 1.1 Add `CouncilModel`, `CouncilEffort`, `CouncilTier`, `CouncilScenario`, `CouncilProvider`, and the `COUNCIL_MODEL_PROVIDER` / provider->harness maps
- [x] 1.2 Add the job catalogue types: `CouncilJobId`, `CouncilBatching`, `CouncilJob` (`tier`, `batching`, `sessionRider`, optional `row`)
- [x] 1.3 Add the override shape (`CouncilOverrides`: per-task and per-tier, each `{ model?, effort?, harness? }`), the availability shape (`CouncilAvailability`), and the harness-default shape
- [x] 1.4 Add `ResolutionSource`, `ResolutionTrace` (structured + human `summary`), and the `CouncilResolution` discriminated union (`model` | `deterministic`)
- [x] 1.5 Add the budget types: `InvocationBudget`, `BudgetGrant` (granted/refused), the `R10_BUDGET_EXHAUSTED` refusal code
- [x] 1.6 Add optional `effort?: string` and `resolutionTrace?: ResolutionTrace` to `RspProvenance`

## 2. The resolver (core: model-council.ts)

- [x] 2.1 The versioned `JOB_CATALOGUE`: every model-facing job (§2.2 light 13 + heavy seats + §2.3 M22-M27) plus the deterministic-floor markers, each with tier / batching / session-rider
- [x] 2.2 The three assignment tables (`ASSIGNMENT_TABLES`), keyed by scenario -> jobId -> `{ model, effort }`, transcribed verbatim from Model Council §3 tables 1-3
- [x] 2.3 `scenarioFor(availability)` — both/claude-only/codex-only, or a degraded fall-through
- [x] 2.4 `resolveAssignment(jobId, ctx)` — pure, deterministic; resolution order task-override -> tier-override -> council table -> harness default; deterministic-tier -> `{ kind: "deterministic" }`; structured + human trace
- [x] 2.5 `providerHarness(model)` / model->harness derivation so the resolver NAMES the Codex seat without building it (#66 boundary)

## 3. The live budget (core: invocation-budget.ts)

- [x] 3.1 `createInvocationBudget(max)` — stateful closure; `tryConsume(purpose)` grants (increments) or refuses over the ceiling; `consumed`/`remaining` getters
- [x] 3.2 The typed refusal (`granted:false` carrying `R10_BUDGET_EXHAUSTED`, consumed/max, reason)

## 4. Wire the budget onto the live runners (core)

- [x] 4.1 `runDecompositionAngle`: optional injected `budget`; consult it before EVERY `runTurn` (first attempt + retries); a refusal records a `budget-refused` attempt and breaks to the deterministic floor
- [x] 4.2 `runOrderingPass`: same optional injected `budget`, same before-every-turn consult, same fail-closed floor fallback
- [x] 4.3 Add `budgetRefused` visibility to both runner results so a consumer can see the ceiling was hit

## 5. Wire the pipeline (core: pipeline.ts)

- [x] 5.1 `buildReviewCanvases` creates ONE shared `createInvocationBudget(maxHarnessInvocations)` and threads it through both runners
- [x] 5.2 Optional `council` context (availability + overrides + harnessDefault); when present, resolve `decomposition-proposal` and `comprehension-ordering` assignments and stamp `{ model, effort, resolutionTrace }` into each phase's provenance seed
- [x] 5.3 Preserve today's behaviour when no council context is supplied (caller-supplied seed model)

## 6. Provenance schema (protocol)

- [x] 6.1 Add optional `effort` and `resolutionTrace` to the provenance zod schema (under the existing `.loose()`; existing documents validate unchanged; `inputDigest` untouched)

## 7. Tests + gates

- [x] 7.1 Resolver: every model-facing job resolves to the correct `{ harness, model, effort }` under each of the three availability scenarios (table-transcription coverage)
- [x] 7.2 Resolver: a task override and a tier override each win in the right precedence order; task beats tier beats table; a partial (effort-only) override keeps the table model; trace records the winning source (red-then-green)
- [x] 7.3 Resolver: R39 cross-harness — a light job (`chunk-titles`) resolves to `codex` while the reviewer (`decomposition-proposal`) resolves to `claude-code` under `both`
- [x] 7.4 Resolver: a deterministic-tier job resolves to `{ kind: "deterministic" }` with no model
- [x] 7.5 Budget: `tryConsume` grants up to `max` then refuses; `consumed`/`remaining` track correctly; the refusal is the typed `R10_BUDGET_EXHAUSTED`
- [x] 7.6 Runner (decomposition): with a budget of 1 and a turn that always rejects, the first turn runs, the retry is budget-refused at runtime (no second `runTurn`), and the deterministic floor stands (red-then-green — a runner that does not consult the budget fails this)
- [x] 7.7 Pipeline: a proposal that retries plus an ordering pass draw from ONE shared budget; a seeded 6th invocation is refused at runtime (both `runTurn` spies together are called exactly `max` times) and both phases fall to the floor
- [x] 7.8 Pipeline: with a council context, the proposal provenance carries the resolved `{ model, effort, resolutionTrace }`; the reviewer and a light job differ in harness under `both`
- [x] 7.9 Grep proof: every live model-invoking path in the pipeline is behind the budget (zero bypass)
- [x] 7.10 Full `pnpm check` green across all projects (real checker, not tsgo)
