---
tags: [rennet, routing, models]
categories: [reference]
status: active
created: 2026-08-07
updated: 2026-08-07
related: ["[[Rennet Product and Vision]]", "[[Rennet Contracts and Rulings]]", "[[Wingman Surfacing DSL and Model Routing Plan]]", "[[Rennet Orchestrator Context Access]]"]
source: 2026-08-07 job-catalogue synthesis (dashboard report) + routing plan §5 + the GREEN Luna spike (#66)
---

# Rennet Model Council

> ⚠️ **RULE ZERO (CLAUDE.md, 2026-08-11) outranks this document.** No consent gates, no gates, no robustness for robustness' sake. The job catalogue, the tier test, the resolver, and the assignment tables are unaffected; the refuse-at-runtime budget gate is not.

**The Model Council is the named subsystem that decides which mind does which job.** Rennet runs ~45 discrete jobs per review; the council owns the versioned table of what each job is, a deterministic resolver that assigns every model-facing job a `(harness, model, effort)` before anything runs, the budget gate on the live path, and a resolution-trace ledger that can always answer "why did this job run on that model."

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. The RoutePlan stays as *planning and accounting* — resolve the assignment, write the trace, show the spend in the ledger — but it does not refuse work at runtime; every "budget gate" in this document reads as a budget *ledger*.

This document is the ratified extraction of [[Wingman Surfacing DSL and Model Routing Plan]] §5 (the plan-era source; its tier doctrine and matrix survive here, its per-harness collapse ladder is amended by R39) plus the 2026-08-07 job-catalogue synthesis. [[Rennet Product and Vision]] §4.11 carries the product framing; rulings live in [[Rennet Contracts and Rulings]].

**Authority note:** the tier test, the batching shapes, the <15s / <5-invocation budget, and never-per-hunk are frozen doctrine (R10). The specific model+effort picks in the three assignment tables are the council's *defaults* — recommendations shipped versioned like a schema, overridable by construction at task and tier level. Changing a default is a table edit, never a code change.

---

## 1. The organising rule

The tier test (routing plan §5.1) survives contact with the full catalogue: **"does this task need to look at code it was not given?"**

- Input fully enumerable in the prompt → **light** (one schema-constrained call, batched, `UtilityPort`).
- The model must go find something → **heavy** (agentic session, repo on disk, `HarnessAdapter`).
- A tool can be 100% right → **no model at all** (`deterministic`).

One constraint the plan states but the council models explicitly: **several heavy jobs ride another job's session** (decision reconstruction, claim↔requirement mapping, and derived-requirement extraction ride the decomposition session; finding generation rides the review session). For riders, **the assignment granularity is the session, not the call** — the council picks one model for the seat, and effort is the per-call knob within it.

The money shape across the whole catalogue: ~13 of ~21 model-facing jobs are light-tier volume on the cheapest capable model; ~4 seats (decomposition proposal + riders, spec derivation, decisions/claims finding generation, adjudication) hold a flagship; everything else is a mid model with a deterministic net under it. The Luna spike (#66, GREEN: validator-admitted RSP ordering document, 4.6s, $0) proved the cheap end passes the admission gate — **the validator, not the model, is the admission authority, which is exactly what makes cheap assignments safe.**

## 2. The job catalogue

Versioned like a schema. Job IDs are stable; status is as of 2026-08-07.

### 2.1 The deterministic floor — no model, ever (24 jobs)

| # | Job | Where it stands |
|---|---|---|
| D1 | Diff ingest, hunk occurrence IDs, lineage graph | ✅ merged (`git-capture.ts`) |
| D2 | Patchset immutability + freshness/invalidation | ✅ merged (`ReviewService`) |
| D3 | GitHub PR ingest (local-diff-first, head pinning, SSO partial detection) | ✅ merged (#20) |
| D4 | Harness discovery + health | ✅ merged |
| D5 | Decomposition floor: ≤400-LOC chunking, import DAG, topo order | ✅ merged (`decompose()`) |
| D6 | Mechanical classification / VERIFIED-noise admission | ✅ merged (floor) |
| D7 | Deterministic test mapping (naming, imports, symbol refs) | queued (#32, tree-sitter/LSP) |
| D8 | Context reach / definition resolution (LSP Tier 0/1) | queued (#23) |
| D9 | Blast-radius signal derivation (irreversibility, contract surface, deletions, fan-in, CODEOWNERS) | queued (#35) |
| D10 | Spec source discovery + parsing (openspec/kiro/superpowers/PR body/ticket) | queued (#8/S1) |
| D11 | RSP validation (V001–V009 + body rules) — the admission authority | ✅ merged |
| D12 | Noise-checker execution (closed predicate vocab: pure-move, format-only, lockfile…) | queued (#34) |
| D13 | Anomaly arithmetic recompute (V700) + deterministic-edge re-derivation (V401) | queued |
| D14 | Canvas projection L0–L3 + actor-partitioned op dispatch | ✅ merged (#10) |
| D15 | Disposition fold + byte-identical carry | ✅ merged (slice 1) |
| D16 | Fuzzy lineage matcher (calibrated carry) | queued (#16) |
| D17 | Prompt assembly (7-slot contract, layered budgets) | ✅ merged (`instructions`) |
| D18 | Context pipeline + ContextManifest (what the fleet is told) | queued (#30) |
| D19 | Base-branch ProjectSnapshot build | queued (#14) |
| D20 | Orchestrator primer build (map-not-container, ≤4KB, versioned) | queued (#13 landed the primer; #65 bounds it) |
| D21 | **RoutePlan build + budget gate (the Brita filter)** | ⚠️ merged but **DEAD CODE** — zero non-test callers (bead p0wwp). §4 wires it live. |
| D22 | Publish pipeline mechanics (batched review, idempotency, degradation ledger) | queued (#21) |
| D23 | Settings resolver + trust gate | queued (#28) |
| D24 | Home-surface GraphQL polling + re-anchoring outdated threads | queued (#37) |

### 2.2 The model-facing jobs (21 named)

**Light tier (14):** committed-spec requirement extraction · chunk titles · disposition triage · **disposition relevance judge (#78, §2.4)** · claim extraction · inferred test mapping · noise narration · noise pattern proposal · finding dedupe · claim canonicalisation · publish comment prose · comment refinement · `context.ask` (fetch/quick) · roll-up narration (M22, §2.3).

**Heavy tier (~8 seats):** spec derivation · decomposition (skeleton + proposal + riders: decision-WHY, claim↔requirement mapping, derived-spec extraction) · finding generation per angle · anomaly spotting · comprehension ordering (cheap heavy — the deterministic floor is its fail-closed net) · orchestrator + diff chat · `context.ask` (thorough) · adjudication / second opinion / self-consistency (LATER).

The full per-job batching shapes, capability gates, and v1 flags remain as specified in the routing plan's §5.2 matrix (rows S1–S4, 1–25); this catalogue does not restate them, it assigns them.

### 2.3 The six jobs no earlier plan had named (added 2026-08-07)

| # | Job | Tier | Why it exists |
|---|---|---|---|
| M22 | **Roll-up narration at every altitude** | light, batched | The matrix had "chunk titles" only — but the product thesis is *zoom*: cohorts, groups, and the whole roll-up each need a one-line + one-paragraph account so "approve at any granularity" is an informed act at *every* granularity. This is the zoom ladder's own voice. |
| M23 | **Live narrative feed** | deterministic events + optional light garnish | "Reading the changeset… 214 hunks… chapter 3 looks like the risky one" — never a spinner (UX Concepts §C; [[Rennet Design Doctrine]]). |
| M24 | **Handoff-bundle composition** | light | Turning N refined dispositions into one coherent task narrative for the coding harness (#18) — ordering, merging overlapping asks, resolving anchor context. |
| M25 | **Delta re-review summarisation** | light | After the handoff loop returns a new patchset: what moved, what the agent did beyond your asks. |
| M26 | **PR title/body drafting** | light, human-editable | The own-branch destination's paper (#22) previews a PR submission; someone has to write the draft. |
| M27 | **Council calibration read** | deterministic aggregation | Reading `dsl.documentRejected` per model per doc-type — the council's own instrument (§5). |

Filed as issues: M22 → #70, M23 → #71, M24 → #72, M25 → #73, M26 → #74, M27 → #75.

### 2.4 Disposition relevance judge (#78, added 2026-08-08)

The span-grained-dispositions keystone (#78) adds one model-facing job: **disposition relevance judge**. On a patchset re-capture, the deterministic byte-identical carry FLOOR drops any disposition whose side-text at its file-line span changed or shifted; the dropped set is offered to this judge, which decides whether each prior disposition is still relevant to the re-captured code (and may re-anchor it). Rai's #48 ruling names a **medium-tier model** — reconciled here as **light tier (bounded inference), medium effort**: the job is handed the prior disposition and the successor patch and never fetches code it was not given, so by §1's tier test it is *light* (sibling to disposition triage); the ruling's "medium model" is the **effort** knob, exactly how disposition triage is Luna-medium. It is batched (across all dropped candidates on a re-capture) and **routed through `resolveAssignment` like every council job, so the live budget gate (p0wwp fix, #81) already covers it — no new gate**. The floor stays pure and deterministically red-provable; the judge is a port, mocked in CI, so the model never runs there.

## 3. The three assignment tables

Model set: **Claude Haiku / Sonnet 5 / Opus 4.8** · **GPT-5.5 / GPT-5.6-Sol / GPT-5.6-Terra / GPT-5.6-Luna**. Effort (low/med/high/xhigh) is the Codex knob; thinking budget is the analogous Claude knob. These tables are the council's availability-default layer (§4): versioned, shipped with the app, human-edited only.

### Table 1 — Both providers available (the ideal)

The review/decomposition sessions stay on **Claude** (first-class adapter, shipped); the light-tier **bulk crosses harnesses to Codex at $0** (the spike's product win, R39); adjudication gets a genuinely independent second voice for free.

| Job | Assignment | Why |
|---|---|---|
| Chunk titles · claim extraction · noise narration · pattern proposal · publish prose · roll-up narration · live-feed garnish · PR-body draft | **Luna low** | Pure formatting/labelling; schema-out, validator-in; the volume lives here |
| Disposition triage · disposition relevance judge (#78) · inferred test mapping · committed-spec requirement extraction · delta summary | **Luna medium** | Bounded inference, still one-shot |
| Finding dedupe · claim canonicalisation | **Terra low** | Identity judgment; slightly more model, still cheap |
| Comment refinement · handoff bundle composition | **Terra medium** | These words publish under the user's name — the quality floor of the light tier |
| `context.ask` — fetch/quick | **Luna low–med** | Never pay a flagship to grep |
| `context.ask` — thorough | **Sonnet 5 (med)** | Synthesis over the snapshot; escalation is budget-gated |
| Decomposition **skeleton** | **Sonnet 5 (low)** | Must beat the 15s first paint; speed is the spec |
| Decomposition **proposal** + riders (decision-WHY, claim↔req mapping, derived-spec extraction) | **Opus 4.8 (high)** | The #1 hard call; no ground truth, maximal blast radius; riders inherit the seat |
| Spec derivation (S3) | **Opus 4.8 (high)** | Reconstructing intent from a diff is the same class of hard |
| Finding generation per angle | **Sonnet 5 (med)**; **Opus 4.8 (high)** on decisions + claims angles only | Most angles are bounded by the admitted docs; the two judgment-dense angles earn the flagship |
| Comprehension ordering | **Terra medium** | Re-ranking a given list; the deterministic floor is the fail-closed net — cheap is correct |
| Anomaly spotting | **Terra medium** | Must open the odd file; arithmetic is validator-recomputed anyway |
| Orchestrator + diff chat | **Sonnet 5 (med)** default; escalate **Opus 4.8 / Sol high** on hard threads | Interactivity beats depth on most turns |
| Adjudication / second opinion | **Opus 4.8 high + Sol high**, fresh sessions | The whole point: two independent providers; a Claude-vs-Codex disagreement is a real signal |
| Self-consistency (divergence-triggered) | Same model as generator, **xhigh/max** | Fires only on observed divergence — the one legitimate xhigh |

### Table 2 — Claude-only (Haiku / Sonnet 5 / Opus 4.8)

| Job | Assignment | Why |
|---|---|---|
| All Luna-low rows above | **Haiku (min thinking)** | Haiku is the Luna of this house; batched utility calls |
| Luna-medium rows (triage, relevance judge #78, test mapping, req extraction, delta summary) | **Haiku (low)** | Still bounded; the validator catches failures, retry escalates to Sonnet |
| Dedupe · canonicalisation · refinement · handoff bundle | **Sonnet 5 (low–med)** | Publishing-quality words and identity judgment sit above Haiku's comfort |
| `context.ask` fetch / thorough | **Haiku** / **Sonnet 5 (med)** | Split unchanged |
| Skeleton | **Sonnet 5 (low)** | Speed |
| Proposal + riders · spec derivation | **Opus 4.8 (high)** | Unchanged — the hard core |
| Finding generation | **Sonnet 5 (med)**; Opus 4.8 on decisions/claims | Unchanged |
| Ordering | **Sonnet 5 (low)** | Floor-protected |
| Orchestrator + chat | **Sonnet 5 (med)** → escalate Opus 4.8 | Unchanged |
| Adjudication | **DEGRADED**: fresh-session Opus 4.8 self-consistency, honest badge "single-provider — correlated second opinion" | The routing plan's own doctrine: never silently pretend independence you don't have |

### Table 3 — Codex-only (GPT-5.5 / Sol / Terra / Luna)

| Job | Assignment | Why |
|---|---|---|
| All light-tier rows (incl. disposition relevance judge #78 — Luna med) | **Luna low/med · Terra low/med** exactly as Table 1 | The light tier was Codex-native already |
| Skeleton | **Terra (medium)** | Speed for the 15s budget |
| Proposal + riders · spec derivation | **Sol (high)** | The flagship takes the hard seat |
| Finding generation | **GPT-5.5 (med)**; **Sol (high)** on decisions + claims | 5.5 is strong at code reading and cheaper than Sol-high per session; the judgment-dense angles still get the flagship |
| Ordering | **Luna (medium)** | *Proven*: the spike's admitted document WAS an ordering doc — the cheapest model already passes the gate here |
| Anomaly | **Terra (medium)** | Unchanged |
| Orchestrator + chat | **Terra (medium)** → escalate **Sol (high)** | Responsiveness default |
| `context.ask` thorough | **Sol (medium)** | Synthesis seat |
| Adjudication | **Sol high + GPT-5.5 high**, fresh sessions, badge "single-provider" | Cross-*model* beats no second voice; honesty badge because same provider ≠ independent |
| Self-consistency | Generator's model at **xhigh** | Divergence-triggered only |

## 4. The council v1 design

```
JOB CATALOGUE (versioned table: jobId → tier, batching shape, session-rider?)
AVAILABILITY PROBE (installed harnesses + earned capability flags)
USER OVERRIDES (routing.task.*.{model,effort} / routing.tier.*.model — #28 keys, all personal, never shareable)
        │
        ▼
resolveAssignment(job, availability, overrides)          ← deterministic, pure
        │  → { harness, model, effort, trace }
        ▼
RoutePlan (built BEFORE any invocation)
        ▼
BUDGET GATE — on the LIVE path (≤5 invocations, retries counted, 6th refused at runtime)
        ▼
Execution: UtilityPort (light, batched) · HarnessAdapter session (heavy)
        ▼
THE LEDGER ("ordering ran on Luna-low because: tier=light · codex available · council row 9 · no override")
        +
CALIBRATION READ (documentRejected rate per model per doc-type → a table a human edits)
```

The commitments:

1. **The resolver is deterministic and inspectable.** Resolution order (amends routing plan §5.4):
   ```
   1. routing.task.<taskId>.model / .effort     (explicit per-task override)
   2. routing.tier.<tier>.model[<harnessId>]    (explicit per-tier override)
   3. the council default table                 (§3, keyed by availability scenario)
   4. the harness's own default
   ```
   The council default table is step 3 — the piece §5.4 did not have. It ships versioned like a schema.
2. **Cross-harness routing is a council power (R39).** Light-tier work MAY route to a *different* installed harness than the one running the review sessions — Claude reviews while cheap Luna does the light thinking at $0. **Default-ON when both harnesses are installed; the user can pin any job or tier to a harness.** This amends the routing plan §5.4 degradation ladder, which collapsed tiers *within* one harness; per-run context disclosure (R31) already covers the egress honesty — the run ledger names every harness that saw material.
3. **Session-riders are seats, not calls.** The resolver assigns per-session for riders, per-call for utility; effort is the intra-session knob.
4. **The budget gate goes live (fixes bead p0wwp).** `buildRoutePlan` is merged and currently dead — zero non-test callers. v1 wires it: `runDecompositionAngle`, `runOrderingPass`, and every future runner consult the RoutePlan **before** invoking; **retries decrement the same budget**; a 6th invocation is **refused at runtime**, not just in a CI test. The CI test stays (it catches drift at build time); the live gate is what makes the ceiling real (money is a vital circuit).

   > ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. Wiring `buildRoutePlan` into the live runners is fine as *planning and measurement*; refusing the 6th invocation at runtime is a fail-closed money circuit and goes — the ≤5-invocation figure stays a performance target the CI test watches, not a runtime refusal.
5. **Every invocation writes its resolution trace to the run ledger.** "This job ran on Luna-low because: tier=light, codex available, council row 9, no override" is a string the UI can show. This is what makes overrides *usable* — you can only override what you can see.
6. **Static forever, measured always.** The calibration read (M27) is the only feedback loop, and it terminates in a **human editing the table**. The council never self-mutates; there is no adaptive routing, no bandit, no learned policy. A rejection-rate spike per model per doc-type ("Luna got promoted above its competence") is a surfaced table you read, and the response is a versioned table edit.

## 5. Calibration

`dsl.documentRejected` is already specced as a log event. The calibration read aggregates it: **rejection rate per model per document type**, surfaced as a table in settings/diagnostics. Interpretation guide shipped with it: a high rejection rate for a (model, docType) pair means that assignment is too cheap for that job; the fix is an edit to the council default table (or a user override), never an automatic demotion. Deterministic aggregation — no model reads the log.

## 6. Degradation (carried forward from routing plan §5.4, amended)

- A harness with no per-call model selection collapses its tiers onto its default model; the batching discipline still protects the budget; the UI shows "one model tier on this harness". Unchanged.
- **New (R39):** before collapsing, the resolver first tries the *other* installed harness for light-tier work — cross-harness routing is preferred over tier collapse, because it preserves both the cost shape and the model fit. Only when no installed harness offers the tier does the collapse ladder run.
- Capability flags (`supportsPerCallModelSelection`, `advertisedModels`) start `false` and are earned by the conformance suite (R13). A flag nobody tested is a claim, not a capability.

> ⛔ **SUPERSEDED 2026-08-11 by RULE ZERO (CLAUDE.md).** No consent gates, no gates, no robustness for robustness' sake. Use a harness capability when the harness advertises it and fall back when it fails; do not withhold a capability until a conformance ceremony is discharged. The conformance suite stays useful as a *test*, not as a permission slip.

## 7. The build

Owner issue: **#69 — Model Council v1** (catalogue + resolver + live budget gate + ledger) — with #66 (CodexUtilityPort, proven), #25 (Codex adapter), and #28's routing keys as its limbs, and the p0wwp live-gate fix in scope. Minimal buildable slice: one module in `packages/core` holding the versioned job table + `resolveAssignment()`; wire `buildRoutePlan` into the two existing live runners; thread `{model, effort, trace}` into the provenance seed both runners already require; land `CodexUtilityPort` as the first alternate seat.

The six newly named jobs (§2.3) are filed as #70–#75; M22 (roll-up narration, #70) is the priority — it is the product thesis's own prose.

---

*Extracted 2026-08-07 from [[Wingman Surfacing DSL and Model Routing Plan]] §5 (historical source; its §5.1–§5.3 doctrine carries forward verbatim, its §5.4 ladder is amended by R39) and the 2026-08-07 job-catalogue synthesis. The three assignment tables are recommendations over the ratified tier matrix + the proven Luna spike: the tiers and batching shapes are doctrine; the specific model+effort picks are judgment, overridable by construction.*
