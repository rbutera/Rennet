/**
 * The Model Council (issue #69) — catalogue + resolver.
 *
 * The council decides WHICH mind does WHICH job. This module holds the versioned
 * job catalogue (every job -> tier, batching shape, session-rider flag), the
 * three availability-default assignment tables (Model Council §3, tables 1-3),
 * and `resolveAssignment` — a pure, deterministic function returning
 * `{ harness, model, effort, trace }` for a model-facing job (and `deterministic`
 * for a floor job). Doc authority:
 * `docs/developing/concepts/model-council.md`.
 *
 * Two doctrines are load-bearing here:
 *   - The tables are the council's DEFAULTS, shipped versioned like a schema.
 *     Changing an assignment is a table edit in this file, never a code change.
 *   - Resolution is deterministic and inspectable: the resolution order is
 *     task-override -> tier-override -> council table -> harness default, and
 *     every resolution carries a trace saying why, so an override is only ever
 *     over something visible.
 *
 * Cross-harness routing (R39) is baked into Table 1: with both harnesses
 * installed the light-tier volume resolves to Codex (Luna/Terra) at $0 while the
 * heavy review sessions stay on Claude (Opus/Sonnet). This module does NOT build
 * the Codex seat (#66); it only NAMES it via `model -> provider -> harness`, so
 * #66 wires the real execution behind a clean boundary.
 */

import type {
  CouncilAvailability,
  CouncilEffort,
  CouncilHarnessDefault,
  CouncilHarnessId,
  CouncilJob,
  CouncilJobId,
  CouncilModel,
  CouncilPick,
  CouncilProvider,
  CouncilResolution,
  CouncilResolveContext,
  CouncilScenario,
  CouncilTier,
  ResolutionSource,
  ResolutionTrace,
} from "@rennet/protocol";

// ── Model → provider → harness ────────────────────────────────────────────────

const MODEL_PROVIDER: Readonly<Record<CouncilModel, CouncilProvider>> = {
  haiku: "claude",
  "sonnet-5": "claude",
  "opus-4.8": "claude",
  "gpt-5.5": "codex",
  "gpt-5.6-sol": "codex",
  "gpt-5.6-terra": "codex",
  "gpt-5.6-luna": "codex",
};

const PROVIDER_HARNESS: Readonly<Record<CouncilProvider, CouncilHarnessId>> = {
  claude: "claude-code",
  codex: "codex",
};

/** The harness a council model runs on — how the resolver NAMES a Codex seat. */
export function providerHarness(model: CouncilModel): CouncilHarnessId {
  return PROVIDER_HARNESS[MODEL_PROVIDER[model]];
}

// ── The versioned job catalogue (Model Council §2) ────────────────────────────

function job(
  jobId: CouncilJobId,
  tier: CouncilTier,
  batching: CouncilJob["batching"],
  sessionRider: boolean,
  label: string,
  row?: number,
): CouncilJob {
  return { jobId, tier, batching, sessionRider, label, ...(row === undefined ? {} : { row }) };
}

/**
 * Every job Rennet runs, versioned. Model-facing jobs (§2.2 + §2.3) carry an
 * assignment in the three tables below; deterministic-floor jobs (§2.1) resolve
 * to no model. Job ids are stable.
 */
export const JOB_CATALOGUE: Readonly<Record<CouncilJobId, CouncilJob>> = Object.freeze(
  Object.fromEntries(
    (
      [
        // ── Light tier (§2.2 + §2.3 M22/M24/M25/M26) ──
        job("chunk-titles", "light", "batched", false, "Chunk titles", 1),
        job("claim-extraction", "light", "batched", false, "Claim extraction", 2),
        job("noise-narration", "light", "batched", false, "Noise narration", 3),
        job("noise-pattern-proposal", "light", "batched", false, "Noise pattern proposal", 4),
        job("publish-comment-prose", "light", "batched", false, "Publish comment prose", 5),
        job("rollup-narration", "light", "batched", false, "Roll-up narration (M22)", 6),
        job("pr-body-draft", "light", "batched", false, "PR title/body draft (M26)", 7),
        job("disposition-triage", "light", "batched", false, "Disposition triage", 8),
        // Issue #78: bounded inference (handed the prior disposition + the
        // successor patch, never fetches code it was not given) — light tier,
        // sibling to disposition-triage; the ruling's "medium model" is the
        // effort knob, not the tier. This table only ROUTES the job: the live
        // budget gate is enforced by the caller consuming the shared
        // InvocationBudget before each turn (as the decomposition/ordering
        // runners do), NOT by resolveAssignment. The concrete relevance judge is
        // a dormant port today (no live caller); wiring it to consume the budget
        // is follow-on work.
        job(
          "disposition-relevance-judge",
          "light",
          "batched",
          false,
          "Disposition relevance judge (#78)",
          27,
        ),
        job("inferred-test-mapping", "light", "batched", false, "Inferred test mapping", 9),
        job(
          "committed-spec-requirement-extraction",
          "light",
          "batched",
          false,
          "Committed-spec requirement extraction",
          10,
        ),
        job(
          "delta-rereview-summary",
          "light",
          "batched",
          false,
          "Delta re-review summary (M25)",
          11,
        ),
        job("finding-dedupe", "light", "batched", false, "Finding dedupe", 12),
        job("claim-canonicalisation", "light", "batched", false, "Claim canonicalisation", 13),
        job("comment-refinement", "light", "batched", false, "Comment refinement", 14),
        job(
          "handoff-bundle-composition",
          "light",
          "batched",
          false,
          "Handoff-bundle composition (M24)",
          15,
        ),
        job(
          "ci-failure-classification",
          "light",
          "batched",
          false,
          "CI failure classification (#182)",
          28,
        ),
        // Issue #461: one retrieval worker per review session, re-run per round.
        // Budget-normal (only the #460 map path is uncapped).
        job(
          "related-context-retrieval",
          "light",
          "batched",
          false,
          "Related-context dossier retrieval (#461)",
          31,
        ),
        // ── Heavy tier (§2.2) ──
        job("decomposition-skeleton", "heavy", "per-call", false, "Decomposition skeleton", 18),
        job("decomposition-proposal", "heavy", "per-call", false, "Decomposition proposal", 19),
        // Riders: they ride the decomposition-proposal session (granularity is the
        // seat, effort the per-call knob). Their table entries mirror the seat.
        job("decision-why", "heavy", "session-rider", true, "Decision WHY reconstruction", 19),
        job(
          "claim-requirement-mapping",
          "heavy",
          "session-rider",
          true,
          "Claim <-> requirement mapping",
          19,
        ),
        job(
          "derived-spec-extraction",
          "heavy",
          "session-rider",
          true,
          "Derived-spec extraction",
          19,
        ),
        job("spec-derivation", "heavy", "per-call", false, "Spec derivation (S3)", 20),
        job("finding-generation", "heavy", "per-call", false, "Finding generation per angle", 21),
        job(
          "finding-generation-decisions-claims",
          "heavy",
          "per-call",
          false,
          "Finding generation — decisions/claims angles",
          21,
        ),
        job("comprehension-ordering", "heavy", "per-call", false, "Comprehension ordering", 22),
        job("anomaly-spotting", "heavy", "per-call", false, "Anomaly spotting", 23),
        job("orchestrator-chat", "heavy", "per-call", false, "Orchestrator + diff chat", 24),
        job("adjudication", "heavy", "per-call", false, "Adjudication / second opinion", 25),
        job("self-consistency", "heavy", "per-call", false, "Self-consistency (divergence)", 26),
        // Issue #461: fills only what the deterministic detection pass could not,
        // at project add (re-runnable). "Medium" in #461 is the model class,
        // not a tier (B06 reconciliation-2 reading).
        job("project-scout", "heavy", "per-call", false, "Project scout (#461)", 32),
        // ── Board-rebuild drafting seats (#489 B08; ids frozen in protocol
        // COUNCIL_JOB_IDS — this file only ROUTES them). Effort is [extrapolated]:
        // #464/#493 fix the seats and the routing shape, not the effort knob.
        // Ordinals 33+ — 32 was taken by project-scout when B07 landed first.
        job("lens-draft", "heavy", "per-call", false, "Lens board draft (B08)", 31),
        job(
          "lens-draft-flagged",
          "heavy",
          "per-call",
          false,
          "Flagged lens draft — dual seat (B08)",
          33,
        ),
        job("lens-draft-noise", "light", "batched", false, "Noise lens draft (B08)", 34),
        job(
          "board-post-process",
          "light",
          "per-call",
          false,
          "Board post-process editor (B08)",
          35,
        ),
        job(
          "round-report",
          "heavy",
          "per-call",
          false,
          "Round-report classification (B08 R58)",
          36,
        ),
        // ── Deterministic floor (§2.1) — no model, ever ──
        job("diff-ingest", "deterministic", "none", false, "Diff ingest + lineage (D1)"),
        job("patchset-immutability", "deterministic", "none", false, "Patchset immutability (D2)"),
        job("github-pr-ingest", "deterministic", "none", false, "GitHub PR ingest (D3)"),
        job("harness-discovery", "deterministic", "none", false, "Harness discovery + health (D4)"),
        job("decomposition-floor", "deterministic", "none", false, "Decomposition floor (D5)"),
        job(
          "mechanical-classification",
          "deterministic",
          "none",
          false,
          "Mechanical classification (D6)",
        ),
        job(
          "deterministic-test-mapping",
          "deterministic",
          "none",
          false,
          "Deterministic test mapping (D7)",
        ),
        job("context-reach", "deterministic", "none", false, "Context reach / definition (D8)"),
        job("blast-radius-signal", "deterministic", "none", false, "Blast-radius signal (D9)"),
        job("spec-source-discovery", "deterministic", "none", false, "Spec source discovery (D10)"),
        job(
          "rsp-validation",
          "deterministic",
          "none",
          false,
          "RSP validation — admission authority (D11)",
        ),
        job("noise-checker", "deterministic", "none", false, "Noise-checker execution (D12)"),
        job(
          "anomaly-arithmetic",
          "deterministic",
          "none",
          false,
          "Anomaly arithmetic recompute (D13)",
        ),
        job(
          "canvas-projection",
          "deterministic",
          "none",
          false,
          "Canvas projection + dispatch (D14)",
        ),
        job("disposition-fold", "deterministic", "none", false, "Disposition fold + carry (D15)"),
        job("fuzzy-lineage-matcher", "deterministic", "none", false, "Fuzzy lineage matcher (D16)"),
        job("prompt-assembly", "deterministic", "none", false, "Prompt assembly (D17)"),
        job(
          "context-pipeline",
          "deterministic",
          "none",
          false,
          "Context pipeline + manifest (D18)",
        ),
        job("base-branch-snapshot", "deterministic", "none", false, "Base-branch snapshot (D19)"),
        job(
          "orchestrator-primer",
          "deterministic",
          "none",
          false,
          "Orchestrator primer build (D20)",
        ),
        job(
          "route-plan-budget-gate",
          "deterministic",
          "none",
          false,
          "RoutePlan + budget gate (D21)",
        ),
        job("publish-pipeline", "deterministic", "none", false, "Publish pipeline mechanics (D22)"),
        job(
          "settings-resolver",
          "deterministic",
          "none",
          false,
          "Settings resolver + trust gate (D23)",
        ),
        job("home-surface-polling", "deterministic", "none", false, "Home-surface polling (D24)"),
        job("live-narrative-feed", "deterministic", "none", false, "Live narrative feed (M23)"),
        job(
          "council-calibration-read",
          "deterministic",
          "none",
          false,
          "Council calibration read (M27)",
        ),
      ] as CouncilJob[]
    ).map((entry) => [entry.jobId, entry]),
  ),
);

// ── The three assignment tables (Model Council §3) ────────────────────────────
//
// Each table maps a model-facing jobId to its (model, effort) DEFAULT under one
// availability scenario. Transcribed from §3. Where §3's prose grouped several
// jobs onto one row the value is repeated; where §3 was silent for a job under a
// scenario (a few heavy jobs Table 2/3 did not restate), the house's mid model
// for that tier is used and marked `[extrapolated]` — a default, overridable.

type AssignmentTable = Readonly<Record<CouncilJobId, CouncilPick>>;

const pick = (model: CouncilModel, effort: CouncilEffort): CouncilPick => ({ model, effort });

/** Table 1 — both providers available (the ideal). R39 cross-harness lives here. */
const TABLE_BOTH: AssignmentTable = {
  // Light → Codex at $0 while review stays on Claude.
  "chunk-titles": pick("gpt-5.6-luna", "low"),
  "claim-extraction": pick("gpt-5.6-luna", "low"),
  "noise-narration": pick("gpt-5.6-luna", "low"),
  "noise-pattern-proposal": pick("gpt-5.6-luna", "low"),
  "publish-comment-prose": pick("gpt-5.6-luna", "low"),
  "rollup-narration": pick("gpt-5.6-luna", "low"),
  "pr-body-draft": pick("gpt-5.6-luna", "low"),
  "disposition-triage": pick("gpt-5.6-luna", "medium"),
  "disposition-relevance-judge": pick("gpt-5.6-luna", "medium"),
  "inferred-test-mapping": pick("gpt-5.6-luna", "medium"),
  "committed-spec-requirement-extraction": pick("gpt-5.6-luna", "medium"),
  "delta-rereview-summary": pick("gpt-5.6-luna", "medium"),
  "finding-dedupe": pick("gpt-5.6-terra", "low"),
  "claim-canonicalisation": pick("gpt-5.6-terra", "low"),
  "comment-refinement": pick("gpt-5.6-terra", "medium"),
  "handoff-bundle-composition": pick("gpt-5.6-terra", "medium"),
  "ci-failure-classification": pick("gpt-5.6-luna", "low"),
  "related-context-retrieval": pick("gpt-5.6-luna", "low"), // #461 light tier; model+effort [extrapolated]
  // Heavy → Claude review seats.
  "decomposition-skeleton": pick("sonnet-5", "low"),
  "decomposition-proposal": pick("opus-4.8", "high"),
  "decision-why": pick("opus-4.8", "high"),
  "claim-requirement-mapping": pick("opus-4.8", "high"),
  "derived-spec-extraction": pick("opus-4.8", "high"),
  "spec-derivation": pick("opus-4.8", "high"),
  // The council seat only; the Flagged dual-model SECOND seat pairs Codex against
  // this drafter at `DEFAULT_CODEX_SECOND_SEAT_MODEL` (dual-seat.ts), not a table row.
  "finding-generation": pick("sonnet-5", "medium"),
  "finding-generation-decisions-claims": pick("opus-4.8", "high"),
  "comprehension-ordering": pick("gpt-5.6-terra", "medium"),
  "anomaly-spotting": pick("gpt-5.6-terra", "medium"),
  "orchestrator-chat": pick("sonnet-5", "medium"),
  adjudication: pick("opus-4.8", "high"), // pairs with Sol-high (fresh session); primary seat here
  "self-consistency": pick("opus-4.8", "xhigh"), // generator's model at xhigh; divergence-triggered
  "project-scout": pick("sonnet-5", "medium"), // #461 names medium (the model class); effort [extrapolated]
  // ── Board-rebuild seats (#489 B08). Heavy lens drafting stays on Claude (R39);
  // the noise draft and post-process editor cross to Codex. The narrow report
  // classifier stays on Claude but no longer pays medium reasoning latency.
  // Effort [extrapolated] — the rulings fix the routing, not the knob.
  "lens-draft": pick("opus-4.8", "high"), // the reading surface: the deep review draft
  // Primary seat only; the Flagged dual SECOND seat pairs Codex via dual-seat.ts
  // (DEFAULT_CODEX_SECOND_SEAT_MODEL), not a table row — mirrors finding-generation.
  "lens-draft-flagged": pick("sonnet-5", "medium"),
  "lens-draft-noise": pick("gpt-5.6-luna", "low"), // mirrors noise-narration (cheap Codex)
  "board-post-process": pick("gpt-5.6-terra", "medium"), // mirrors comment-refinement (prose editor)
  "round-report": pick("sonnet-5", "low"),
};

/** Table 2 — Claude-only (Haiku / Sonnet 5 / Opus 4.8). */
const TABLE_CLAUDE_ONLY: AssignmentTable = {
  "chunk-titles": pick("haiku", "low"),
  "claim-extraction": pick("haiku", "low"),
  "noise-narration": pick("haiku", "low"),
  "noise-pattern-proposal": pick("haiku", "low"),
  "publish-comment-prose": pick("haiku", "low"),
  "rollup-narration": pick("haiku", "low"),
  "pr-body-draft": pick("haiku", "low"),
  "disposition-triage": pick("haiku", "low"),
  "disposition-relevance-judge": pick("haiku", "low"),
  "inferred-test-mapping": pick("haiku", "low"),
  "committed-spec-requirement-extraction": pick("haiku", "low"),
  "delta-rereview-summary": pick("haiku", "low"),
  "finding-dedupe": pick("sonnet-5", "low"),
  "claim-canonicalisation": pick("sonnet-5", "low"),
  "comment-refinement": pick("sonnet-5", "medium"),
  "handoff-bundle-composition": pick("sonnet-5", "medium"),
  "ci-failure-classification": pick("haiku", "low"),
  "decomposition-skeleton": pick("sonnet-5", "low"),
  "decomposition-proposal": pick("opus-4.8", "high"),
  "decision-why": pick("opus-4.8", "high"),
  "claim-requirement-mapping": pick("opus-4.8", "high"),
  "derived-spec-extraction": pick("opus-4.8", "high"),
  "spec-derivation": pick("opus-4.8", "high"),
  "finding-generation": pick("sonnet-5", "medium"),
  "finding-generation-decisions-claims": pick("opus-4.8", "high"),
  "comprehension-ordering": pick("sonnet-5", "low"),
  "anomaly-spotting": pick("sonnet-5", "medium"), // [extrapolated] §3 Table 2 was silent; house mid model
  "orchestrator-chat": pick("sonnet-5", "medium"),
  adjudication: pick("opus-4.8", "high"), // degraded single-provider self-consistency; badge at execution
  "self-consistency": pick("opus-4.8", "xhigh"),
  "related-context-retrieval": pick("haiku", "low"), // [extrapolated] #461 silent on claude-only; house light model
  "project-scout": pick("sonnet-5", "medium"), // #461 names medium (the model class); effort [extrapolated]
  // ── Board-rebuild seats (#489 B08). Effort [extrapolated]. ──
  "lens-draft": pick("opus-4.8", "high"),
  "lens-draft-flagged": pick("sonnet-5", "medium"),
  "lens-draft-noise": pick("haiku", "low"), // [extrapolated] house light model, mirrors noise-narration
  "board-post-process": pick("sonnet-5", "medium"),
  "round-report": pick("sonnet-5", "low"),
};

/** Table 3 — Codex-only (Sol / Terra / Luna). */
const TABLE_CODEX_ONLY: AssignmentTable = {
  "chunk-titles": pick("gpt-5.6-luna", "low"),
  "claim-extraction": pick("gpt-5.6-luna", "low"),
  "noise-narration": pick("gpt-5.6-luna", "low"),
  "noise-pattern-proposal": pick("gpt-5.6-luna", "low"),
  "publish-comment-prose": pick("gpt-5.6-luna", "low"),
  "rollup-narration": pick("gpt-5.6-luna", "low"),
  "pr-body-draft": pick("gpt-5.6-luna", "low"),
  "disposition-triage": pick("gpt-5.6-luna", "medium"),
  "disposition-relevance-judge": pick("gpt-5.6-luna", "medium"),
  "inferred-test-mapping": pick("gpt-5.6-luna", "medium"),
  "committed-spec-requirement-extraction": pick("gpt-5.6-luna", "medium"),
  "delta-rereview-summary": pick("gpt-5.6-luna", "medium"),
  "finding-dedupe": pick("gpt-5.6-terra", "low"),
  "claim-canonicalisation": pick("gpt-5.6-terra", "low"),
  "comment-refinement": pick("gpt-5.6-terra", "medium"),
  "handoff-bundle-composition": pick("gpt-5.6-terra", "medium"),
  "ci-failure-classification": pick("gpt-5.6-luna", "low"),
  "decomposition-skeleton": pick("gpt-5.6-terra", "medium"),
  "decomposition-proposal": pick("gpt-5.6-sol", "high"),
  "decision-why": pick("gpt-5.6-sol", "high"),
  "claim-requirement-mapping": pick("gpt-5.6-sol", "high"),
  "derived-spec-extraction": pick("gpt-5.6-sol", "high"),
  "spec-derivation": pick("gpt-5.6-sol", "high"),
  // The finding seat is the review's judgement seat: strongest Codex model.
  "finding-generation": pick("gpt-5.6-sol", "high"),
  "finding-generation-decisions-claims": pick("gpt-5.6-sol", "high"),
  "comprehension-ordering": pick("gpt-5.6-luna", "medium"),
  "anomaly-spotting": pick("gpt-5.6-terra", "medium"),
  "orchestrator-chat": pick("gpt-5.6-terra", "medium"),
  adjudication: pick("gpt-5.6-sol", "high"), // pairs with Sol-high (fresh session); primary seat here
  "self-consistency": pick("gpt-5.6-sol", "xhigh"),
  "related-context-retrieval": pick("gpt-5.6-luna", "low"), // #461 light tier; model+effort [extrapolated]
  "project-scout": pick("gpt-5.6-terra", "medium"), // [extrapolated] #461 silent on codex-only; house mid model
  // ── Board-rebuild seats (#489 B08). Effort [extrapolated]. ──
  "lens-draft": pick("gpt-5.6-sol", "high"), // strongest Codex model for the review draft
  "lens-draft-flagged": pick("gpt-5.6-sol", "high"),
  "lens-draft-noise": pick("gpt-5.6-luna", "low"),
  "board-post-process": pick("gpt-5.6-terra", "medium"),
  "round-report": pick("gpt-5.6-terra", "low"),
};

export const ASSIGNMENT_TABLES: Readonly<Record<CouncilScenario, AssignmentTable>> = {
  both: TABLE_BOTH,
  "claude-only": TABLE_CLAUDE_ONLY,
  "codex-only": TABLE_CODEX_ONLY,
};

/** The ultimate fallback used in the degraded path (no council harness installed). */
export const DEFAULT_HARNESS_DEFAULT: CouncilHarnessDefault = {
  harness: "claude-code",
  model: "sonnet-5",
  effort: "medium",
};

// ── The resolver ──────────────────────────────────────────────────────────────

/**
 * Which of the three canonical scenarios the installed set matches, or `null`
 * when neither Claude nor Codex is installed (the degraded path). `omp` is
 * ignored for scenario selection: the tables cover Claude and Codex.
 */
export function scenarioFor(availability: CouncilAvailability): CouncilScenario | null {
  const installed = new Set(availability.installed);
  const claude = installed.has("claude-code");
  const codex = installed.has("codex");
  if (claude && codex) return "both";
  if (claude) return "claude-only";
  if (codex) return "codex-only";
  return null;
}

function scenarioClause(scenario: CouncilScenario | "degraded"): string {
  switch (scenario) {
    case "both":
      return "both providers";
    case "claude-only":
      return "claude only";
    case "codex-only":
      return "codex only";
    default:
      return "no council harness installed";
  }
}

function sourceClause(source: ResolutionSource): string {
  switch (source) {
    case "task-override":
      return "task override";
    case "tier-override":
      return "tier override";
    case "harness-default":
      return "harness default";
    case "degraded":
      return "degraded fallback";
    default:
      return "no override";
  }
}

/**
 * The harness the heavy review sessions run on under a scenario, computed from
 * the decomposition-proposal seat's table entry. Used to mark a light-tier
 * resolution as cross-harness (R39) when it lands on a different harness.
 */
function reviewHarnessFor(scenario: CouncilScenario): CouncilHarnessId {
  const proposal = ASSIGNMENT_TABLES[scenario]["decomposition-proposal"];
  // decomposition-proposal is present in every table; the fallback keeps the
  // function total under `noUncheckedIndexedAccess` without an assertion.
  return proposal === undefined ? "claude-code" : providerHarness(proposal.model);
}

/**
 * Resolve one job to an assignment. Pure and deterministic. Resolution order:
 * task override -> tier override -> council default table (by availability
 * scenario) -> harness default. A deterministic-tier job resolves to no model.
 * Throws only for an unknown job id (a programming error, never a data one).
 */
export function resolveAssignment(
  jobId: CouncilJobId,
  ctx: CouncilResolveContext,
): CouncilResolution {
  const job = JOB_CATALOGUE[jobId];
  if (job === undefined) {
    throw new Error(`resolveAssignment: unknown jobId "${jobId}" (not in the versioned catalogue)`);
  }

  const scenario = scenarioFor(ctx.availability);

  if (job.tier === "deterministic") {
    const trace: ResolutionTrace = {
      jobId,
      tier: "deterministic",
      scenario: scenario ?? "degraded",
      source: "council-table",
      ...(job.row === undefined ? {} : { row: job.row }),
      summary: `${jobId} is a deterministic-floor job: no model, ever (${scenarioClause(scenario ?? "degraded")})`,
    };
    return { kind: "deterministic", trace };
  }

  // Base assignment: the council default table for this scenario, or the harness
  // default in the degraded path.
  let model: CouncilModel;
  let effort: CouncilEffort;
  let source: ResolutionSource;

  const harnessDefault = ctx.harnessDefault ?? DEFAULT_HARNESS_DEFAULT;

  if (scenario === null) {
    model = harnessDefault.model;
    effort = harnessDefault.effort;
    source = "degraded";
  } else {
    const tablePick = ASSIGNMENT_TABLES[scenario][jobId];
    if (tablePick === undefined) {
      // A model-facing job the table did not name: honest fall-through to the
      // harness default rather than a fabricated pick.
      model = harnessDefault.model;
      effort = harnessDefault.effort;
      source = "harness-default";
    } else {
      model = tablePick.model;
      effort = tablePick.effort;
      source = "council-table";
    }
  }

  // Layer the tier override, then the task override (task wins). Each overwrites
  // only the fields it sets; harness always follows the resolved model — an override
  // sets model/effort only, it can never pin an incoherent harness (#89).
  const tierOverride = ctx.overrides?.tier?.[job.tier];
  if (tierOverride !== undefined && (tierOverride.model || tierOverride.effort)) {
    if (tierOverride.model !== undefined) {
      model = tierOverride.model;
    }
    if (tierOverride.effort !== undefined) effort = tierOverride.effort;
    source = "tier-override";
  }

  const taskOverride = ctx.overrides?.task?.[jobId];
  if (taskOverride !== undefined && (taskOverride.model || taskOverride.effort)) {
    if (taskOverride.model !== undefined) {
      model = taskOverride.model;
    }
    if (taskOverride.effort !== undefined) effort = taskOverride.effort;
    source = "task-override";
  }

  const harness = providerHarness(model);
  const crossHarness =
    job.tier === "light" && scenario !== null && harness !== reviewHarnessFor(scenario);

  const traceScenario: CouncilScenario | "degraded" = scenario ?? "degraded";
  const rowClause = job.row === undefined ? "" : ` · council row ${job.row}`;
  const trace: ResolutionTrace = {
    jobId,
    tier: job.tier,
    scenario: traceScenario,
    source,
    ...(crossHarness ? { crossHarness: true } : {}),
    ...(job.row === undefined ? {} : { row: job.row }),
    summary: `${jobId} ran on ${model}-${effort} (${harness}) because: tier=${job.tier} · ${scenarioClause(traceScenario)}${rowClause} · ${sourceClause(source)}`,
  };

  return { kind: "model", harness, model, effort, trace };
}
