// ─────────────────────────────────────────────────────────────────────────────
// Manifests — ids as data (B3, #489). The stable id vocabularies the engine and
// client share: lens kinds, prompt ids, council job ids. The bytes stay with
// their owners — prompt files in `@rennet/prompts`, council routing tables in
// core (B6/B7/B8 bind the job ids); this folder is the id authority.
// ─────────────────────────────────────────────────────────────────────────────

import type { CouncilBatching, CouncilTier } from "../domain";

/** The five lenses, in display order: Design first, then the reading walk. */
export const LENS_KINDS = ["design", "sequence", "decisions", "flagged", "noise"] as const;

export type LensKind = (typeof LENS_KINDS)[number];

/**
 * Prompt ids as data: one per lens draft, plus the round-report seat, the
 * post-process editor, and the review-draft voice rules. The prompt FILES
 * (paths and bytes) stay in `@rennet/prompts` — these ids are what manifests
 * and job tables cite.
 */
export const PROMPT_IDS = [...LENS_KINDS, "report", "post-process", "review-draft-voice"] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

/** A stable job id in the versioned catalogue. */
export type CouncilJobId = string;

/**
 * One catalogue entry: WHAT the job is (its tier, batching shape, and whether it
 * rides another session) — never WHICH model, which is the assignment table's
 * job. Shipped versioned like a schema; job ids are stable.
 */
export interface CouncilJob {
  readonly jobId: CouncilJobId;
  readonly tier: CouncilTier;
  readonly batching: CouncilBatching;
  /** True when the job rides another job's session (granularity is the seat). */
  readonly sessionRider: boolean;
  /** Optional matrix row number, purely for the resolution-trace flavour. */
  readonly row?: number;
  readonly label: string;
}

/**
 * The board-rebuild job-id vocabulary (#489 plan), as data: the stable ids the
 * council routing tables bind in B6/B7/B8. Routing (which model, which tier)
 * stays in core.
 */
export const COUNCIL_JOB_IDS = [
  "lens-draft",
  "lens-draft-flagged",
  "lens-draft-noise",
  "board-post-process",
  "round-report",
  "project-scout",
  "related-context-retrieval",
] as const;

export type BoardCouncilJobId = (typeof COUNCIL_JOB_IDS)[number];
