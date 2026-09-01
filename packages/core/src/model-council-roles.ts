/**
 * The review-role catalogue + all-scenario resolver (C16, #485).
 *
 * The Model Council (`model-council.ts`) routes every job. This module gives the
 * Environments → Review settings surface a READABLE view of the eight
 * user-legible review roles → their backing council jobs, resolved across all
 * three availability scenarios (`both` / `claude-only` / `codex-only`) with
 * `{ value, source }` provenance per cell.
 *
 * It ADDS no job ids and CHANGES no table value: `REVIEW_ROLE_CATALOGUE` points
 * only at ids that already live in `JOB_CATALOGUE`, and `resolveReviewRoles`
 * reuses `resolveAssignment` (table default + `overrides.task` layer) per
 * (role, scenario) rather than re-implementing the layering. The one construct
 * not in a table is the Flagged Second Seat — a Codex seat paired against the
 * Claude drafter via `dual-seat.ts` — so it resolves in `both` and is
 * honest-null in the single-provider scenarios (never a fabricated pick).
 */

import type {
  CouncilAvailability,
  CouncilHarnessDefault,
  CouncilJobId,
  CouncilPick,
  CouncilScenarioOverrides,
  ResolutionSource,
  ReviewRoleCell,
  ReviewRoleMapping,
  ReviewRoleScenario,
} from "@rennet/protocol";
import { DEFAULT_CODEX_SECOND_SEAT_EFFORT, DEFAULT_CODEX_SECOND_SEAT_MODEL } from "./dual-seat";
import { JOB_CATALOGUE, resolveAssignment } from "./model-council";

/** The eight user-legible review roles (the copy the surface lists). */
export type ReviewRoleId =
  | "orchestrator"
  | "map-workers"
  | "confirmation"
  | "lens-workers"
  | "second-seat"
  | "adjudication"
  | "post-process"
  | "utility";

/** One catalogue entry: a role, its surface copy, and its backing council job. */
export interface ReviewRoleDef {
  readonly id: ReviewRoleId;
  readonly label: string;
  readonly hint: string;
  /** The backing council job id — always a key of `JOB_CATALOGUE` (no new ids). */
  readonly jobId: CouncilJobId;
  /**
   * The Flagged Second Seat is a dual-model construct (`dual-seat.ts`), not a
   * single-provider table job: it resolves only under `both` and is honest-null
   * in `claude-only` / `codex-only`.
   */
  readonly dualOnly?: boolean;
}

/**
 * The authoritative role → job map. Each role reuses an id already in
 * `JOB_CATALOGUE`; a role naming an id absent from the catalogue is a
 * fabrication and fails the catalogue-integrity test.
 */
export const REVIEW_ROLE_CATALOGUE: readonly ReviewRoleDef[] = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    hint: "The review seat that drives the diff chat and orchestrates the round.",
    jobId: "orchestrator-chat",
  },
  {
    id: "confirmation",
    label: "Confirmation Worker",
    hint: "The self-consistency pass that re-runs on divergence to confirm findings.",
    jobId: "self-consistency",
  },
  {
    id: "lens-workers",
    label: "Lens Drafters",
    hint: "The heavy seat that drafts the review lens — the reading surface.",
    jobId: "lens-draft",
  },
  {
    id: "second-seat",
    label: "Flagged Second Seat",
    hint: "The Codex second opinion paired against the Claude drafter on flagged lenses. Dual-provider only.",
    jobId: "lens-draft-flagged",
    dualOnly: true,
  },
  {
    id: "adjudication",
    label: "Adjudication",
    hint: "The second-opinion seat that adjudicates disagreement between seats.",
    jobId: "adjudication",
  },
  {
    id: "post-process",
    label: "Post-Process",
    hint: "The light editor that cleans the board's prose after drafting.",
    jobId: "board-post-process",
  },
];

/** Every job id the catalogue names, for the no-fabrication guard test. */
export const REVIEW_ROLE_JOB_IDS: readonly CouncilJobId[] = REVIEW_ROLE_CATALOGUE.map(
  (role) => role.jobId,
);

/** True iff every catalogued job id is a real `JOB_CATALOGUE` key (no new ids). */
export function reviewRoleCatalogueIsIntegral(): boolean {
  return REVIEW_ROLE_JOB_IDS.every((jobId) => JOB_CATALOGUE[jobId] !== undefined);
}

/** A single resolved scenario cell: the pick and where it came from, or honest-null. */
export interface ResolvedRoleCell {
  /** The resolved model+effort, or `null` when the role does not run in this scenario. */
  readonly value: CouncilPick | null;
  /** Which layer won (`council-table` / `task-override` / …), or `null` when unassigned. */
  readonly source: ResolutionSource | null;
}

/** A role resolved across all three scenarios, each cell carrying its provenance. */
export interface ResolvedReviewRole {
  readonly id: ReviewRoleId;
  readonly label: string;
  readonly hint: string;
  readonly dual: ResolvedRoleCell;
  readonly claudeOnly: ResolvedRoleCell;
  readonly codexOnly: ResolvedRoleCell;
}

const NULL_CELL: ResolvedRoleCell = { value: null, source: null };

/**
 * The persisted `routing.task` slice: council job id → that job's PER-SCENARIO
 * override cells. Rai's 2026-08-28 ruling — each column owns its own override, so
 * an edit in one scenario cannot move the other two.
 */
export type ReviewRoleOverrides = Readonly<Record<string, CouncilScenarioOverrides>>;

/**
 * What `resolveReviewRoles` resolves against. NOT a `CouncilResolveContext`: the
 * all-scenario walk supplies each scenario's own availability itself (see
 * `SCENARIO_AVAILABILITY`), and its overrides are keyed by (job, scenario) rather
 * than by job alone.
 */
export interface ReviewRoleResolveContext {
  readonly overrides?: ReviewRoleOverrides;
  readonly harnessDefault?: CouncilHarnessDefault;
}

/** The synthetic availability that selects each scenario's assignment table. */
const SCENARIO_AVAILABILITY: Readonly<Record<ReviewRoleScenario, CouncilAvailability>> = {
  dual: { installed: ["claude-code", "codex"] },
  claudeOnly: { installed: ["claude-code"] },
  codexOnly: { installed: ["codex"] },
};

/** Every column, in surface order — the walk and the write share this list. */
export const REVIEW_ROLE_SCENARIOS = ["dual", "claudeOnly", "codexOnly"] as const;

/**
 * Resolve one normal (table-backed) role for one scenario, layering **only that
 * scenario's own** override cell over that scenario's table default. Reuses
 * `resolveAssignment` so the source is honest (`council-table` unless this
 * column's own task override wins) — a sibling column's override is not passed
 * in, so it cannot leak across.
 */
function resolveTableCell(
  jobId: CouncilJobId,
  scenario: ReviewRoleScenario,
  ctx: ReviewRoleResolveContext,
): ResolvedRoleCell {
  const cell = ctx.overrides?.[jobId]?.[scenario];
  const resolution = resolveAssignment(jobId, {
    availability: SCENARIO_AVAILABILITY[scenario],
    ...(cell === undefined ? {} : { overrides: { task: { [jobId]: cell } } }),
    ...(ctx.harnessDefault === undefined ? {} : { harnessDefault: ctx.harnessDefault }),
  });
  if (resolution.kind !== "model") return NULL_CELL;
  return {
    value: { model: resolution.model, effort: resolution.effort },
    source: resolution.trace.source,
  };
}

/**
 * The Flagged Second Seat in `dual`: the Codex second-seat default
 * (`dual-seat.ts`), overridable by that job's `dual` override cell. Honest-null in
 * every single-provider scenario.
 */
function resolveSecondSeatDual(
  ctx: ReviewRoleResolveContext,
  jobId: CouncilJobId,
): ResolvedRoleCell {
  const override = ctx.overrides?.[jobId]?.dual;
  const overridden = override?.model !== undefined || override?.effort !== undefined;
  return {
    value: {
      model: override?.model ?? DEFAULT_CODEX_SECOND_SEAT_MODEL,
      effort: override?.effort ?? DEFAULT_CODEX_SECOND_SEAT_EFFORT,
    },
    source: overridden ? "task-override" : "council-table",
  };
}

/**
 * Resolve every review role across all three scenarios. Pure and deterministic:
 * the caller's `overrides`/`harnessDefault` are the only inputs; the scenarios
 * are resolved unconditionally (honest-present — the tables are always
 * available), so the surface renders the eight roles even with no override set.
 * A role that does not run in a scenario resolves to a `null` cell, never a guess.
 */
export function resolveReviewRoles(ctx: ReviewRoleResolveContext): ResolvedReviewRole[] {
  return REVIEW_ROLE_CATALOGUE.map((role) => {
    const base = { id: role.id, label: role.label, hint: role.hint };
    if (role.dualOnly) {
      return {
        ...base,
        dual: resolveSecondSeatDual(ctx, role.jobId),
        claudeOnly: NULL_CELL,
        codexOnly: NULL_CELL,
      };
    }
    return {
      ...base,
      dual: resolveTableCell(role.jobId, "dual", ctx),
      claudeOnly: resolveTableCell(role.jobId, "claudeOnly", ctx),
      codexOnly: resolveTableCell(role.jobId, "codexOnly", ctx),
    };
  });
}

/**
 * The backing council job id for a role id, or `undefined` when the id is not a
 * catalogued role. The write path (`settings.setRoleAssignment`) maps through
 * here, so an override can only ever land on a job the catalogue already names.
 */
export function reviewRoleJobId(roleId: string): CouncilJobId | undefined {
  return REVIEW_ROLE_CATALOGUE.find((role) => role.id === roleId)?.jobId;
}

/**
 * Collapse a resolved cell's `ResolutionSource` to the two layers the surface
 * renders: a `task-override` won (`override`), or the council table stands
 * (`default`). An honest-null cell keeps `default` — nothing overrode a role
 * that does not run in that scenario.
 */
function toWireCell(cell: ResolvedRoleCell): ReviewRoleCell {
  return { value: cell.value, layer: cell.source === "task-override" ? "override" : "default" };
}

/**
 * The wire view of the review-role mappings (C16, #485) — `resolveReviewRoles`
 * mapped onto `reviewRoleMappingSchema`, which is what `settings.get` carries and
 * `settings.setRoleAssignment` returns. `overrides` is the persisted per-scenario
 * `routing.task` slice; passing `undefined` yields the pure council defaults
 * (honest-present: the tables are static, so this is never empty).
 */
export function reviewRoleMappings(overrides?: ReviewRoleOverrides): ReviewRoleMapping[] {
  return resolveReviewRoles(overrides === undefined ? {} : { overrides }).map((role) => ({
    id: role.id,
    label: role.label,
    hint: role.hint,
    dual: toWireCell(role.dual),
    claudeOnly: toWireCell(role.claudeOnly),
    codexOnly: toWireCell(role.codexOnly),
  }));
}
