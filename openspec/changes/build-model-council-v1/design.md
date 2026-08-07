# Design — Model Council v1

## The two independent mechanisms

The council splits cleanly into two things that must not be conflated:

1. **`resolveAssignment` — WHICH mind.** Pure, deterministic, no I/O. Given a job id and a context (installed harnesses + user overrides), it returns `{ harness, model, effort, trace }`. This is the model-selection the merged code never had.
2. **The invocation budget — HOW MANY turns.** A stateful counter that every runner draws from before it spends. This is R10's money ceiling made real on the live path.

They meet only at the pipeline, which resolves the model for each phase and threads one shared budget through both runners.

## resolveAssignment resolution order

Exactly the four steps of Model Council §4.1, highest precedence first:

```
1. routing.task.<jobId>            explicit per-task override (model and/or effort)
2. routing.tier.<tier>             explicit per-tier override (model and/or effort)
3. the council default table        §3, keyed by the availability scenario
4. the harness default              the ultimate fallback
```

Implementation: compute the council-table base (`model`, `effort`) for the job's tier under the resolved scenario, then layer the tier override, then the task override, each overwriting only the fields it sets. The winning override level (`task` / `tier` / `none`) is recorded in the trace. A partial override (effort only, model kept from the table) is honest in the trace because each field carries its source. Task wins over tier wins over table wins over harness default.

## The availability scenario

The three assignment tables ARE the degradation handling for the three canonical scenarios, so the resolver picks the table by availability rather than running a collapse ladder:

- `claude-code` and `codex` both installed -> `both` (Table 1). Light-tier work is on Codex (Luna/Terra) while the review/proposal sessions stay on Claude (Opus/Sonnet) — R39 cross-harness, baked into the table.
- `claude-code` only -> `claude-only` (Table 2, all Claude).
- `codex` only -> `codex-only` (Table 3, all Codex).
- neither of the two -> the harness default with a `degraded` trace note (e.g. only `omp`, or empty).

`omp` is ignored for scenario selection because the tables cover Claude and Codex; a run with only `omp` installed falls to the harness default honestly rather than pretending a table applies.

## R39 cross-harness routing, and why it is not a separate ladder here

Model Council §6 says the resolver, before collapsing tiers within one harness, first tries the OTHER installed harness for light-tier work. In v1 that preference is already expressed by Table 1's design: when both harnesses are installed, light jobs resolve to Codex models (harness `codex`) while heavy review jobs resolve to Claude models (harness `claude-code`), so a light job resolves to a DIFFERENT harness than the reviewer. The collapse ladder proper (a harness with no per-call model selection collapsing its tiers) is a later slice; v1 encodes the three tables and the harness-default fallback, which is sufficient for the three canonical scenarios and the acceptance.

## The deterministic tier

`resolveAssignment` is total over the catalogue. A `deterministic`-tier job (the 24-job floor, plus M23/M27's deterministic parts) resolves to `{ kind: "deterministic", trace }` — no model, no harness, no effort. This keeps the catalogue the single versioned table (§2.1 + §2.2 + §2.3) while making it a type error to read a `model` off a deterministic resolution.

## The invocation budget — one shared ceiling, retries counted

The bead p0wwp gap is precise: the pre-flight `buildRoutePlan` count never sees retries or the ordering phase. The fix is a single stateful counter seeded from `maxHarnessInvocations` (5), threaded through both runners, consumed once per actual `runTurn`:

```
budget = createInvocationBudget(maxHarnessInvocations)      // 5
runDecompositionAngle(budget): proposal + up to 2 retries   // draws from budget
runOrderingPass(budget):        ordering + up to 2 retries   // draws from the SAME budget
```

Worst case without a gate: proposal(1) + 2 retries + ordering(1) + 2 retries = 6 turns. The budget of 5 refuses the 6th at runtime. A refusal is fail-closed: the runner records a `budget-refused` attempt (carrying the typed `R10_BUDGET_EXHAUSTED` refusal) and falls to the deterministic floor exactly as it does on a terminal turn failure — no crash, so a review still renders real canvases from the floor. The refusal is typed and tested (the assertion is: after the ceiling, `runTurn` is not called again, and the result flags the refusal), which is what "refused at runtime with a typed error" means for a subsystem that must never take down a review.

The pre-flight `buildRoutePlan` refusal stays: it catches a pathologically large diff before any spend AND is the build-time drift guard. The two are complementary — the plan refuses an over-budget SHAPE up front; the live budget refuses an over-budget RUN as it happens.

## Why the budget is injected, not global

The runners keep an OPTIONAL `budget` parameter. Injected, they gate; absent, they behave exactly as before (this keeps every existing runner unit test green — those tests exercise the runner in isolation without a budget). The LIVE path is the pipeline, and the pipeline ALWAYS creates and threads the budget, so on the live path both runners are gated and a grep proves no live model path bypasses it. This is the same injection discipline the runners already use for `runTurn`: the caller owns the wiring, the module stays pure and testable.

## Provenance threading

`RspProvenance` gains two optional fields: `effort?: string` and `resolutionTrace?: ResolutionTrace`. Both are optional and the provenance zod schema is already `.loose()`, so existing documents validate unchanged and the `inputDigest` (computed over `{patchsetRef, manifest}`, never provenance) is untouched. When the pipeline is given a council context it resolves the phase's assignment and stamps `model`, `effort`, and `resolutionTrace` into the seed; absent a council context the pipeline preserves today's behaviour (the caller-supplied seed model), so existing callers are unaffected.

## What is deliberately NOT here

- The real `CodexUtilityPort` / `codex exec` execution (#66) — the resolver only names the seat via `model -> provider -> harness`; the seat abstraction is a clean boundary #66 slots into.
- The settings persistence keys (#28) — the override object is the shape those keys deserialise into; nothing in core changes when #28 lands.
- The calibration read (M27) — the council is static forever, measured always; there is no adaptive routing here.
- The within-harness tier-collapse ladder (§6) beyond the three canonical tables — a later slice.
