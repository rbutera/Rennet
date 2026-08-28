/**
 * The review-role catalogue (C16, #485).
 *
 * The Model Council (`model-council.ts`) routes every job. This module gives the
 * Environments → Review settings surface a READABLE view of the eight
 * user-legible review roles → their backing council jobs.
 *
 * It ADDS no job ids: `REVIEW_ROLE_CATALOGUE` points only at ids that already
 * live in `JOB_CATALOGUE`. The one construct not in a table is the Flagged
 * Second Seat — a Codex seat paired against the Claude drafter via
 * `dual-seat.ts` — modelled as a dual-only role so the resolver (see
 * `resolveReviewRoles`) can honest-null it in the single-provider scenarios.
 */

import type { CouncilJobId } from "@rennet/protocol";
import { JOB_CATALOGUE } from "./model-council";

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
    id: "map-workers",
    label: "Context-Map Workers",
    hint: "The light fan-out that maps the change's context, one turn per slice.",
    jobId: "partition-worker",
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
  {
    id: "utility",
    label: "Utility",
    hint: "Light utility work — quick context fetches and formatting.",
    jobId: "context-ask-fetch",
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
