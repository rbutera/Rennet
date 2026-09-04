// The durable-session shapes (#466 resolution, 2026-08-26; #457 vocabulary).
//
// Shapes only: the state machine, locks, and rework queue are B9's; dispatch
// binding is B4/B10's. The transport wire layer lives beside this in
// `wire.ts` (#376) — two session contracts, one folder seam.

import { z } from "zod";
import {
  AskLifecycleSchema,
  generationIdForPatchset,
  LensAbsenceReasonSchema,
  QuoteAnchorSchema,
  RoundReportBoardSchema,
} from "../board";
// Thread anchors cite code through the canonical CodeRef (delta/citations, B3 task 6.2).
import { codeRefSchema, patchFileSchema } from "../delta/citations";
import type { CouncilEffort, CouncilHarnessId, CouncilModel } from "../domain";
import { forgeRepoIdentitySchema, forgeRepositoryMatchesLegacy } from "../forge";
import { LENS_KINDS } from "../manifests";
import { sha256Hex } from "../sha256";

const id = z.string().min(1);

/** The coding harness one own-branch session is pinned to for its work-order rounds. */
export const CodingHarnessSelectionSchema = z.object({
  id: z.enum(["claude-code", "codex"]),
  version: id,
});
export type CodingHarnessSelection = z.infer<typeof CodingHarnessSelectionSchema>;

/**
 * The harness cursor (#466 res. 3, the T3 cursor-resume shape): interactive
 * turns run fresh-process-per-turn + `resume`, so the durable session persists
 * where the harness conversation left off. The harness owns the transcript;
 * Rennet owns only this pointer into it.
 */
export const HarnessCursorSchema = z.object({
  harnessSessionId: id,
  lastAssistantMessageAnchor: id,
  turnCount: z.number().int().nonnegative(),
});
export type HarnessCursor = z.infer<typeof HarnessCursorSchema>;

/**
 * The claimed target (#466 res. 11): a branch and its PR are ONE claimed thing
 * — every New-chat row resolving to either disappears while the claim holds.
 * Archive-only release; a merged target keeps its claim.
 */
export const ClaimSchema = z.object({
  branch: id,
  prNumber: z.number().int().positive().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Does a claim own this target? A branch and its PR are ONE claimed thing, so a match on
 * EITHER half is a match: a row resolving to the PR is owned by a session that claimed the
 * branch, and vice versa.
 *
 * It lives in protocol because BOTH ends decide with it and they must not drift — the host
 * reattaches a New-chat entry to the session already claiming its target (`SessionEntry`),
 * and the client hides the rows a live claim owns (New Chat). Two copies of this rule would
 * eventually disagree, and the visible symptom would be a row that mints a second session.
 */
export function claimMatchesTarget(
  claim: Claim,
  target: { readonly branch: string; readonly prNumber?: number },
): boolean {
  if (claim.branch === target.branch) return true;
  return claim.prNumber !== undefined && claim.prNumber === target.prNumber;
}

/**
 * A thread anchor (#466 res. 7): a code-line citation or a prose quote. One
 * mechanism — code-line comment, prose-quote comment, and Explain are all
 * messages entering the session carrying one of these.
 */
export const ThreadAnchorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("code"), ref: codeRefSchema }),
  z.object({ type: z.literal("quote"), quote: QuoteAnchorSchema }),
]);
export type ThreadAnchor = z.infer<typeof ThreadAnchorSchema>;

/**
 * The ask specialization (#452 hand-off design; #462 R29–R34): a typed message
 * carrying an anchor, text, an intent, and an exit lane, with provenance back
 * to its source. `exitLane` stays an open string — the exits are decided
 * (post review / dispatch round / open PR) but the lane id vocabulary locks
 * with B9's state machine, not here.
 */
export const AskSchema = z.object({
  intent: z.string().min(1),
  exitLane: z.string().min(1),
  provenance: id,
  lifecycle: AskLifecycleSchema,
});
export type Ask = z.infer<typeof AskSchema>;

/**
 * An anchored conversation thread (#466 res. 7). Thread CONTENT lives only in
 * the session transcript; boards and the diff store anchor→thread references —
 * this shape is that reference, plus the ask riding on it when one was minted.
 *
 * Two arms, not independent optionals: the ask specialization REQUIRES an
 * anchor (#462 R29–R34 — an ask is anchor + intent + exit lane + provenance +
 * lifecycle), so `{threadId, ask}` without an anchor does not parse. A plain
 * conversation thread carries no ask and may or may not be anchored.
 */
export const SessionThreadSchema = z.union([
  z.object({ threadId: id, anchor: ThreadAnchorSchema, ask: AskSchema }),
  z.object({
    threadId: id,
    anchor: ThreadAnchorSchema.optional(),
    // Present-and-defined `ask` must take the anchored arm above.
    ask: z.never().optional(),
  }),
]);
export type SessionThread = z.infer<typeof SessionThreadSchema>;

// Absence admissibility moved to `board/kind-tables.ts` in `lens-board-tools`: a seat's
// board tool set is derived from it (whether the lens gets a settle-absent verb, and which
// absence that verb declares) and `protocol/board` cannot import `protocol/session`.
// Re-exported here so every existing importer keeps its path.
export {
  LENS_ADMISSIBLE_ABSENCES,
  type LensAbsenceReason,
  LensAbsenceReasonSchema,
  lensAdmitsAbsence,
} from "../board";

/**
 * A generation (#457): one immutable visit to a review's boards over a patchset.
 * `patchsetId` identifies the content; `id` distinguishes later visits to the same
 * content. Live boards are append-only logs; when the code moves, the generation
 * freezes immutable and a successor is minted — the successor account compares N vs N+1.
 */
/**
 * Whether a further attempt at a failed lens could plausibly succeed (#549). A drafting
 * turn that emitted no board is `retryable` — the seat ran and produced nothing, which
 * is exactly what a retry addresses; a seat that never produced a parseable board across
 * its whole ladder has already spent those retries, so it is `terminal`.
 */
export const LensFailureClassificationSchema = z.enum(["retryable", "terminal"]);
export type LensFailureClassification = z.infer<typeof LensFailureClassificationSchema>;

/**
 * The durable account beside a lens failure MESSAGE: which attempt produced it and
 * whether another attempt could plausibly succeed. The message alone cannot say either,
 * so a reader (and a restart) that has only the string has to guess "terminal" — which
 * is what it did before this shape existed.
 */
export const LensFailureAccountSchema = z.object({
  /** The seat attempt that failed; `0` is the initial drafting turn. */
  attempt: z.number().int().nonnegative(),
  classification: LensFailureClassificationSchema,
});
export type LensFailureAccount = z.infer<typeof LensFailureAccountSchema>;

/**
 * The phases one generation is measured in (#725 D4, and the spine #726's benchmark
 * records ride). Each is a REAL boundary in the drafting runtime, so no label can absorb
 * another phase's time: `report` is the whole report gate and `report-classification` the
 * provider turn inside it (the gate also builds and measures the evidence manifest,
 * resolves the seat and verifies the result deterministically), the three `lens-*`
 * phases split one lane's provider drafting from its repair ladder and from the
 * deterministic work between the ladder and the accepted write, `reveal` is the window
 * in which settled lanes became visible, and
 * `first-core-board` is measured from the round's own start to the first core lane's
 * arrival — the latency the reviewer actually waits.
 */
export const GenerationPhaseSchema = z.enum([
  "report",
  // The classification TURN inside the report gate (#731 9.4). `report` is the whole
  // gate — manifest build, seat resolution, turn, deterministic verification, write —
  // and this is the provider turn alone, which is the only part of it a harness ran and
  // therefore the only part that can name one.
  "report-classification",
  "lens-draft",
  "lens-repair",
  "lens-post-process",
  // Legacy: the cross-lens coverage gate that recorded this phase is gone (session-bound-
  // workspace D5). It stays in the vocabulary so generations measured before then still parse.
  "coverage",
  "reveal",
  "first-core-board",
]);
export type GenerationPhase = z.infer<typeof GenerationPhaseSchema>;

const councilHarnessIds = ["claude-code", "codex"] as const satisfies readonly CouncilHarnessId[];

/**
 * The phases that measure ONE lane and therefore must name it. Everything else is
 * generation-wide and must not: a `reveal` record carrying a lens would read as "the
 * reveal for Design", which is not a thing that exists.
 */
export const LENS_SCOPED_PHASES = [
  "lens-draft",
  "lens-repair",
  "lens-post-process",
  "first-core-board",
] as const satisfies readonly GenerationPhase[];

/**
 * One phase's durable timing record. `startedAtMs` is a wall-clock epoch so records from
 * different phases can be ordered and overlapped without a shared cursor; `durationMs` is
 * the measured span. `harness`/`model` name what ACTUALLY executed the stage (the Council
 * routes per job, so a run-level label would be an assumption) and are absent for phases
 * no provider ran.
 *
 * `lens` is DISCRIMINATED, not merely optional (#725 7.4): the four lane-scoped phases
 * require it and the three generation-wide ones forbid it, so neither "a lane record that
 * forgot which lane" nor "a cross-lens record attributed to one lens" is representable.
 * This is a constraint on the RECORD, not a new field — a generation written before
 * timings existed carries no `timings` at all and keeps parsing untouched.
 */
export const GenerationPhaseTimingSchema = z
  .object({
    phase: GenerationPhaseSchema,
    lens: z.enum(LENS_KINDS).optional(),
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    harness: z.enum(councilHarnessIds).optional(),
    model: z.string().min(1).optional(),
  })
  .superRefine((timing, ctx) => {
    const laneScoped = (LENS_SCOPED_PHASES as readonly GenerationPhase[]).includes(timing.phase);
    if (laneScoped && timing.lens === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lens"],
        message: `the ${timing.phase} phase measures one lane and must name its lens`,
      });
    }
    if (!laneScoped && timing.lens !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lens"],
        message: `the ${timing.phase} phase is generation-wide and must not name a lens`,
      });
    }
  });
export type GenerationPhaseTiming = z.infer<typeof GenerationPhaseTimingSchema>;

/** The timing-record schema version. Bump when a record's MEANING changes; adding an
 *  optional field does not, since every reader already tolerates its absence. */
export const GENERATION_TIMINGS_VERSION = 1;

/**
 * A generation's durable per-phase timings. Versioned from day one so a later reader can
 * tell a v1 record from a v2 one instead of guessing from which fields happen to be
 * present.
 */
export const GenerationTimingsSchema = z.object({
  version: z.literal(GENERATION_TIMINGS_VERSION),
  phases: z.array(GenerationPhaseTimingSchema),
});
export type GenerationTimings = z.infer<typeof GenerationTimingsSchema>;

/**
 * What one generation's provider turns cost (#737). Summed over every seat turn the
 * lens pipeline ran for this generation, retries included — a retry is a new cold
 * session that re-bills its whole prompt, so it counts in full. `reportedUsd` is the
 * provider's own figure summed, and it is `null` unless EVERY turn ran on a metered
 * credential and reported one: a subscription session pays no per-token price, so the
 * round shows tokens and no invented dollar amount. Cumulative while the generation
 * runs (it rides the `lens` frame beside the lanes), final on the durable record.
 */
export const GenerationUsageSchema = z.object({
  /** Every recorded seat turn, measured or not. */
  turns: z.number().int().nonnegative(),
  /** Turns that produced no usage record (no result frame, or a harness that reports
   *  none); their tokens are NOT in the sums below, so the reader is told. */
  unmeasuredTurns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reportedUsd: z.number().nonnegative().nullable(),
});
export type GenerationUsage = z.infer<typeof GenerationUsageSchema>;

export const GenerationSchema = z.object({
  id,
  patchsetId: id,
  /** Exact structural-map + knowledge revision consumed by this draft. Optional only for
   * generations written before Context Map completion became a drafting dependency. */
  projectContextRevision: id.optional(),
  /** Per-lens draft boards (L2), keyed by lens; present once drafted. */
  lensBoards: z.partialRecord(z.enum(LENS_KINDS), id),
  /** Pre-minted ids for the one drafting attempt currently allowed to write BoardMeta. */
  draftingBoardIds: z.partialRecord(z.enum(LENS_KINDS), id).optional(),
  /** The current attempt's exact report slot. Presence does not claim the report drafted. */
  draftingReportBoardId: id.optional(),
  /** Successful per-lens absences, distinct from a board that has not arrived yet. */
  absentLenses: z.partialRecord(z.enum(LENS_KINDS), LensAbsenceReasonSchema).optional(),
  /** Failures from the most recent drafting attempt, in the drafter's own words. */
  failedLenses: z.partialRecord(z.enum(LENS_KINDS), z.string().min(1)).optional(),
  /** The typed account for each `failedLenses` entry that could name one (#549). APPEND-ONLY
   * beside the message: sessions written before this field carry the string alone and must
   * keep parsing, so nothing may move the message into here or require this to be present. */
  failedLensAccounts: z.partialRecord(z.enum(LENS_KINDS), LensFailureAccountSchema).optional(),
  /** The orchestrator-authored composition board (L3), once composed. */
  compositionBoardId: id.optional(),
  /** Per-phase durable timings for this generation (#725 D4). Append-only and versioned. */
  timings: GenerationTimingsSchema.optional(),
  /** What this generation's seat turns cost (#737). Append-only beside the timings:
   *  generations written before this field carry none, and absent means "not measured",
   *  never "free". */
  usage: GenerationUsageSchema.optional(),
  status: z.enum(["live", "frozen"]),
});
export type Generation = z.infer<typeof GenerationSchema>;

/**
 * The honest no-mint marker for a dispatch-only round's generation fields. A round
 * that ran a work-order but regenerated NO boards (the record-only path) has no minted
 * generation and no report board; both generation fields carry this marker to say so
 * explicitly, rather than a fabricated generation id or a board id pointing at nothing.
 */
export const ROUND_NO_REGEN = "no-regen";

/** One exact staged-ask occurrence. Ask ids are reusable after unstage/restore, so the
 * event sequence that last staged, restored, or edited the active ask is its revision. */
export const AskOccurrenceSchema = z.object({
  id,
  revision: z.number().int().nonnegative(),
});
export type AskOccurrence = z.infer<typeof AskOccurrenceSchema>;

/**
 * The sidecar turn checkpoint that captured one round's work (session-bound-workspace D2).
 * A round is a turn on the session's bound thread, so this — not a worktree path — is the
 * receipt, and `thread.checkpoint.revert` against it is what makes a round revertible.
 */
export const RoundCheckpointSchema = z.object({
  threadId: id,
  turnId: id,
  turnCount: z.number().int().nonnegative(),
});
export type RoundCheckpoint = z.infer<typeof RoundCheckpointSchema>;

/**
 * The session's BOUND workspace a round runs in, and the head it started from.
 *
 * There is no detached worktree per round any more (session-bound-workspace D1/D2): the
 * round is a turn in the root the session bound at creation, its commits land on the
 * session's branch, and `sourceHead` is that root's head before the turn — the baseline the
 * observed commit range is measured against.
 */
export const RoundWorkspaceReceiptSchema = z.object({
  kind: z.literal("bound-root"),
  root: id,
  sourceHead: id,
  preparedAt: z.number().int().nonnegative(),
  /**
   * The workspace is on the round's branch but its head no longer contains the reviewed
   * commit — the reviewer amended, rebased or reset it since. NOT a refusal: that is a
   * thing people do on purpose, and the successor patchset is a fresh capture from
   * `sourceHead` either way. Recorded so the account can say the round ran against a
   * rewritten branch. Absent means it did contain it.
   */
  branchRewritten: z.literal(true).optional(),
});
export type RoundWorkspaceReceipt = z.infer<typeof RoundWorkspaceReceiptSchema>;

export const RoundWorkerAttemptSchema = z.object({
  executionId: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundWorkerAttempt = z.infer<typeof RoundWorkerAttemptSchema>;

const completedWorkerBase = {
  ...RoundWorkerAttemptSchema.shape,
  completedAt: z.number().int().nonnegative(),
  diff: z.string(),
  changedPaths: z.array(z.string()),
  /** Exact harness/version that executed this worker. Optional only for legacy operations. */
  harness: CodingHarnessSelectionSchema.optional(),
  /** The sidecar checkpoint for this round's turn. Absent when the turn wrote none. */
  checkpoint: RoundCheckpointSchema.optional(),
};

export const RoundTerminationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exit"),
    exitCode: z
      .number()
      .int()
      .refine((value) => value !== 0),
  }),
  z.object({ kind: z.literal("signal"), signal: id }),
  z.object({ kind: z.literal("error"), reason: z.string().min(1) }),
]);
export type RoundTermination = z.infer<typeof RoundTerminationSchema>;

export const RoundWorkerCompletedReceiptSchema = z.object({
  ...completedWorkerBase,
  outcome: z.literal("completed"),
});
export type RoundWorkerCompletedReceipt = z.infer<typeof RoundWorkerCompletedReceiptSchema>;

export const RoundWorkerFailedReceiptSchema = z.object({
  ...completedWorkerBase,
  outcome: z.literal("failed"),
  termination: RoundTerminationSchema,
});
export type RoundWorkerFailedReceipt = z.infer<typeof RoundWorkerFailedReceiptSchema>;

/** What the coding worker actually returned. A failed worker keeps its partial diff. */
export const RoundWorkerReceiptSchema = z.discriminatedUnion("outcome", [
  RoundWorkerCompletedReceiptSchema,
  RoundWorkerFailedReceiptSchema,
]);
export type RoundWorkerReceipt = z.infer<typeof RoundWorkerReceiptSchema>;

export const RoundCommitAttemptSchema = z.object({
  executionId: id,
  baseHead: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundCommitAttempt = z.infer<typeof RoundCommitAttemptSchema>;

/** The commits observed after the worker's turn settles. Equal endpoints with count zero
 * are an honest no-commit result; a nonzero count is derived from Git. */
export const RoundCommitReceiptSchema = z.object({
  ...RoundCommitAttemptSchema.shape,
  from: id,
  to: id,
  count: z.number().int().nonnegative(),
  committedAt: z.number().int().nonnegative(),
});
export type RoundCommitReceipt = z.infer<typeof RoundCommitReceiptSchema>;

export const RoundRecordingAttemptSchema = z.object({
  effect: z.literal("round-recording"),
  executionId: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundRecordingAttempt = z.infer<typeof RoundRecordingAttemptSchema>;

export const RoundRecordingReceiptSchema = RoundRecordingAttemptSchema.extend({
  recordedAt: z.number().int().nonnegative(),
});
export type RoundRecordingReceipt = z.infer<typeof RoundRecordingReceiptSchema>;

/** The exact verified report projection handed to the renderer while the rest of the
 * successor boards were still regenerating. The outer operation owns `operationId`; the
 * revision records the durable report-attempt epoch that emitted this projection. */
export const RoundReportHandoffSchema = z
  .object({
    operationId: id,
    operationRevision: z.number().int().nonnegative(),
    reportBoardId: id,
    generation: id,
    report: RoundReportBoardSchema,
  })
  .superRefine((handoff, context) => {
    if (handoff.report.boardId !== handoff.reportBoardId) {
      context.addIssue({
        code: "custom",
        path: ["report", "boardId"],
        message: "does not match reportBoardId",
      });
    }
    if (handoff.report.generation !== handoff.generation) {
      context.addIssue({
        code: "custom",
        path: ["report", "generation"],
        message: "does not match generation",
      });
    }
  });
export type RoundReportHandoff = z.infer<typeof RoundReportHandoffSchema>;

export const RoundReportDraftAttemptSchema = z
  .object({
    executionId: id,
    reportBoardId: id,
    generation: id,
    boardIds: z.object({
      design: id,
      sequence: id,
      decisions: id,
      flagged: id,
      noise: id,
      report: id,
    }),
    /** Present after the early report passed its durable read-back verification. */
    handoff: RoundReportHandoffSchema.optional(),
    startedAt: z.number().int().nonnegative(),
  })
  .superRefine((attempt, context) => {
    if (attempt.reportBoardId !== attempt.boardIds.report) {
      context.addIssue({
        code: "custom",
        path: ["reportBoardId"],
        message: "does not match boardIds.report",
      });
    }
    if (
      attempt.handoff !== undefined &&
      (attempt.handoff.reportBoardId !== attempt.reportBoardId ||
        attempt.handoff.generation !== attempt.generation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["handoff"],
        message: "does not match the reserved report identity",
      });
    }
  });
export type RoundReportDraftAttempt = z.infer<typeof RoundReportDraftAttemptSchema>;

export const RoundReportDraftReceiptSchema = RoundReportDraftAttemptSchema.safeExtend({
  draftedAt: z.number().int().nonnegative(),
});
export type RoundReportDraftReceipt = z.infer<typeof RoundReportDraftReceiptSchema>;

export const RoundReportVerificationAttemptSchema = z.object({
  executionId: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundReportVerificationAttempt = z.infer<typeof RoundReportVerificationAttemptSchema>;

/** A report is complete only once the durable board named here has been verified readable. */
export const RoundReportReceiptSchema = RoundReportDraftReceiptSchema.safeExtend({
  verificationExecutionId: id,
  verificationStartedAt: z.number().int().nonnegative(),
  verifiedAt: z.number().int().nonnegative(),
});
export type RoundReportReceipt = z.infer<typeof RoundReportReceiptSchema>;

const failureBase = {
  reason: z.string().min(1),
  failedAt: z.number().int().nonnegative(),
};

export const RoundOperationFailureSchema = z.discriminatedUnion("at", [
  z.object({ at: z.literal("preparing"), ...failureBase }),
  z.object({
    at: z.literal("worker"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: z.union([RoundWorkerFailedReceiptSchema, RoundWorkerAttemptSchema]),
  }),
  z.object({
    at: z.literal("committing"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commit: RoundCommitAttemptSchema,
  }),
  z.object({
    at: z.literal("round-recording"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingAttemptSchema,
  }),
  z.object({
    at: z.literal("report-drafting"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftAttemptSchema,
  }),
  z.object({
    at: z.literal("report-verifying"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftReceiptSchema,
    verification: RoundReportVerificationAttemptSchema,
  }),
]);
export type RoundOperationFailure = z.infer<typeof RoundOperationFailureSchema>;

/** A round's durable phase. Each active arm carries every settled receipt needed to resume at
 * that boundary, so a restart cannot mistake missing evidence for completed work. */
export const RoundOperationStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("claimed") }),
  z.object({ phase: z.literal("prepared"), workspace: RoundWorkspaceReceiptSchema }),
  z.object({
    phase: z.literal("worker-running"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerAttemptSchema,
  }),
  z.object({
    phase: z.literal("worker-settled"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
  }),
  z.object({
    phase: z.literal("committing"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commit: RoundCommitAttemptSchema,
  }),
  z.object({
    phase: z.literal("commits-settled"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
  }),
  z.object({
    phase: z.literal("round-recording"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingAttemptSchema,
  }),
  z.object({
    phase: z.literal("round-recorded"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingReceiptSchema,
  }),
  z.object({
    phase: z.literal("report-drafting"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftAttemptSchema,
  }),
  z.object({
    phase: z.literal("report-verifying"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftReceiptSchema,
    verification: RoundReportVerificationAttemptSchema,
  }),
  z.object({
    phase: z.literal("completed"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    commits: RoundCommitReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("changed"), report: RoundReportReceiptSchema }),
      z.object({ kind: z.literal("unchanged") }),
    ]),
    completedAt: z.number().int().nonnegative(),
    /** Durable proof that Return, exact ask consumption, and terminal cleanup finished. */
    returnedAt: z.number().int().nonnegative().optional(),
  }),
  z.object({
    phase: z.literal("failed"),
    failure: RoundOperationFailureSchema,
  }),
]);
export type RoundOperationState = z.infer<typeof RoundOperationStateSchema>;

function reportHandoffFromOperationState(
  state: RoundOperationState,
): RoundReportHandoff | undefined {
  if (state.phase === "report-drafting" || state.phase === "report-verifying") {
    return state.report.handoff;
  }
  if (state.phase === "completed" && state.result.kind === "changed") {
    return state.result.report.handoff;
  }
  if (
    state.phase === "failed" &&
    (state.failure.at === "report-drafting" || state.failure.at === "report-verifying")
  ) {
    return state.failure.report.handoff;
  }
  return undefined;
}

export const RoundSourceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), branch: id }),
  z.object({ kind: z.literal("detached"), head: id }),
]);
export type RoundSourceTarget = z.infer<typeof RoundSourceTargetSchema>;

/** Immutable host facts about where and when one durable round ran. */
export const RoundRunReceiptSchema = z.object({
  startedAt: z.number().int().nonnegative(),
  sourceTarget: RoundSourceTargetSchema,
  /** Exact coding harness selected before the worker started. Absent only on legacy rows. */
  harness: CodingHarnessSelectionSchema.optional(),
  /**
   * The session's bound workspace root the round ran in (round-harness-dispatch). Absent
   * only on rows written before the binding, never a detached per-round worktree path.
   */
  workspaceRoot: id.optional(),
  /** The sidecar checkpoint that captured the round's commits. Absent on legacy rows. */
  checkpoint: RoundCheckpointSchema.optional(),
  /** The branch had been rewritten past the reviewed head when this round started. */
  branchRewritten: z.literal(true).optional(),
});
export type RoundRunReceipt = z.infer<typeof RoundRunReceiptSchema>;

function hasChangedRoundEvidence(
  worker: { diff: string; changedPaths: string[] },
  commits: { count: number; from: string; to: string },
): boolean {
  return (
    worker.diff.trim().length > 0 &&
    worker.changedPaths.length > 0 &&
    commits.count > 0 &&
    commits.from !== commits.to
  );
}

/** The one durable owner of a session's round from dispatch claim through report verification.
 * `revision` is the store CAS token; `rerunRequested` coalesces a dispatch attempted while the
 * operation is active so its ask snapshot is built only after this operation drains. */
export const RoundOperationSchema = z
  .object({
    operationId: id,
    sessionId: id,
    reviewId: id,
    dispatchId: id,
    sourcePatchsetId: id,
    askOccurrences: z.array(AskOccurrenceSchema).min(1),
    roundNumber: z.number().int().positive(),
    sourceTarget: RoundSourceTargetSchema,
    repoRoot: id,
    workOrderPrompt: z.string().min(1),
    /**
     * The composed work-order DOCUMENT the turn reads (session-context-files). The prompt
     * above only NAMES it; the daemon writes this into the bound root's context directory
     * before the turn, and rewrites it after a restart, so a resumed round still finds the
     * exact order it was dispatched with rather than a recomposed one. Optional for
     * operations persisted while the order travelled inline as the prompt.
     */
    workOrderDocument: z.string().min(1).optional(),
    workOrderDigest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().nonnegative(),
    rerunRequested: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    state: RoundOperationStateSchema,
  })
  .superRefine((operation, context) => {
    if (operation.workOrderDigest !== sha256Hex(operation.workOrderPrompt)) {
      context.addIssue({
        code: "custom",
        path: ["workOrderDigest"],
        message: "does not match workOrderPrompt",
      });
    }
    const askIds = operation.askOccurrences.map((occurrence) => occurrence.id);
    if (new Set(askIds).size !== askIds.length) {
      context.addIssue({
        code: "custom",
        path: ["askOccurrences"],
        message: "contains duplicate ask ids",
      });
    }
    if (operation.updatedAt < operation.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "precedes createdAt",
      });
    }
    const state = operation.state;
    const reportHandoff = reportHandoffFromOperationState(state);
    if (
      reportHandoff !== undefined &&
      (reportHandoff.operationId !== operation.operationId ||
        reportHandoff.operationRevision > operation.revision)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "report", "handoff"],
        message: "does not belong to this durable operation revision",
      });
    }
    const failure = state.phase === "failed" ? state.failure : undefined;
    const commits =
      state.phase !== "failed" && "commits" in state
        ? state.commits
        : failure !== undefined && "commits" in failure
          ? failure.commits
          : undefined;
    const workspace =
      state.phase !== "failed" && "workspace" in state
        ? state.workspace
        : failure !== undefined && "workspace" in failure
          ? failure.workspace
          : undefined;
    const changedEvidenceIsValid =
      state.phase === "report-drafting" || state.phase === "report-verifying"
        ? hasChangedRoundEvidence(state.worker, state.commits)
        : state.phase === "completed" && state.result.kind === "changed"
          ? hasChangedRoundEvidence(state.worker, state.commits)
          : state.phase === "failed" &&
              (state.failure.at === "report-drafting" || state.failure.at === "report-verifying")
            ? hasChangedRoundEvidence(state.failure.worker, state.failure.commits)
            : true;
    if (!changedEvidenceIsValid) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "report path requires worker and commit evidence of changed code",
      });
    }
    if (
      operation.state.phase === "completed" &&
      operation.state.result.kind === "unchanged" &&
      (operation.state.worker.diff.trim().length > 0 ||
        operation.state.worker.changedPaths.length > 0 ||
        operation.state.commits.count !== 0 ||
        operation.state.commits.from !== operation.state.commits.to)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "result"],
        message: "unchanged result contradicts worker or commit evidence",
      });
    }
    if (
      operation.state.phase === "completed" &&
      operation.state.returnedAt !== undefined &&
      operation.state.returnedAt < operation.state.completedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "returnedAt"],
        message: "precedes completedAt",
      });
    }
    if (commits !== undefined && commits.baseHead !== commits.from) {
      context.addIssue({
        code: "custom",
        path: ["state", "commits", "baseHead"],
        message: "does not match the observed commit range start",
      });
    }
    // The chain that keeps a round's evidence bound to the round's own source. `baseHead`
    // is already pinned to `from`, so tying the workspace's head to `baseHead` closes it:
    // a receipt cannot describe a commit range measured from some other checkout's head.
    if (
      workspace !== undefined &&
      commits !== undefined &&
      workspace.sourceHead !== commits.baseHead
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "commits", "baseHead"],
        message: "does not match the workspace head the round started from",
      });
    }
    if (
      operation.sourceTarget.kind === "detached" &&
      workspace !== undefined &&
      workspace.sourceHead !== operation.sourceTarget.head
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "workspace", "sourceHead"],
        message: "does not match the detached source head",
      });
    }
  });
export type RoundOperation = z.infer<typeof RoundOperationSchema>;

// The run screen receives a redacted projection of the durable operation. These stage
// receipts contain only facts the UI renders. Local paths, prompts, diffs, changed paths,
// commit hashes, execution ids, and repository/session identities stay server-side.
const settledWorkspace = z.object({ status: z.literal("done") });
const failedWorkspace = z.object({
  status: z.literal("failed"),
  reason: z.string().min(1),
});

const runningWorker = z.object({ status: z.literal("running") });
const settledWorker = z.object({
  status: z.literal("done"),
  fileCount: z.number().int().nonnegative(),
});
const failedWorker = z.object({
  status: z.literal("failed"),
  reason: z.string().min(1),
  fileCount: z.number().int().nonnegative().optional(),
});

const runningCommits = z.object({ status: z.literal("running") });
const settledCommits = z.object({
  status: z.literal("done"),
  count: z.number().int().nonnegative(),
});
const failedCommits = z.object({
  status: z.literal("failed"),
  reason: z.string().min(1),
});

const draftingReport = z.object({ status: z.literal("drafting") });
/**
 * The report has been drafted, read back and durably HANDED OFF (#728) — the boundary
 * after which the lens drafters run. The durable operation stays in `report-drafting`
 * across that fan-out because it has no separate phase for it, so without this the surface
 * reported the entire lens fan-out as "drafting the round report" (#725 7.4): a running
 * label naming a phase that had already finished, absorbing every lens lane's time.
 */
const handedOffReport = z.object({
  status: z.literal("handed-off"),
  reportBoardId: id,
  generation: id,
});
const verifyingReport = z.union([
  z.object({
    status: z.literal("verifying"),
    reportBoardId: id,
    generation: id,
  }),
  /** Backward-compatible progress from daemons that did not project report identity yet. */
  z.object({ status: z.literal("verifying") }),
]);
const verifiedReport = z.object({
  status: z.literal("verified"),
  reportBoardId: id,
  generation: id,
});
const failedReport = z.object({
  status: z.literal("failed"),
  step: z.enum(["drafting", "verifying"]),
  reason: z.string().min(1),
});

const RoundOperationProgressFailureSchema = z.discriminatedUnion("at", [
  z.object({
    at: z.literal("preparing"),
    workspace: failedWorkspace,
  }),
  z.object({
    at: z.literal("worker"),
    workspace: settledWorkspace,
    worker: failedWorker,
  }),
  z.object({
    at: z.literal("committing"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: failedCommits,
  }),
  z.object({
    at: z.literal("report-drafting"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: settledCommits,
    report: failedReport,
  }),
  z.object({
    at: z.literal("report-verifying"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: settledCommits,
    report: failedReport,
  }),
]);

/** Redacted durable operation state. Every arm carries all settled receipts before it. */
export const RoundOperationProgressStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("claimed") }),
  z.object({ phase: z.literal("prepared"), workspace: settledWorkspace }),
  z.object({
    phase: z.literal("worker-running"),
    workspace: settledWorkspace,
    worker: runningWorker,
  }),
  z.object({
    phase: z.literal("worker-settled"),
    workspace: settledWorkspace,
    worker: settledWorker,
  }),
  z.object({
    phase: z.literal("committing"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: runningCommits,
  }),
  z.object({
    phase: z.literal("commits-settled"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: settledCommits,
  }),
  z.object({
    phase: z.literal("report-drafting"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: settledCommits,
    report: z.union([draftingReport, handedOffReport]),
  }),
  z.object({
    phase: z.literal("report-verifying"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: settledCommits,
    report: verifyingReport,
  }),
  z.object({
    phase: z.literal("completed"),
    workspace: settledWorkspace,
    worker: settledWorker,
    commits: settledCommits,
    result: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("changed"),
        report: verifiedReport,
      }),
      z.object({ kind: z.literal("unchanged") }),
    ]),
  }),
  z.object({
    phase: z.literal("failed"),
    failure: RoundOperationProgressFailureSchema,
  }),
]);
export type RoundOperationProgressState = z.infer<typeof RoundOperationProgressStateSchema>;

/** The complete, restart-safe progress snapshot sent to the run UI. */
export const RoundOperationProgressSnapshotSchema = z.object({
  operationId: id,
  revision: z.number().int().nonnegative(),
  /** Optional for progress snapshots emitted by older daemons. */
  rerunRequested: z.boolean().optional(),
  /** True while terminal Return and exact ask consumption are still resumable. */
  draining: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  roundNumber: z.number().int().positive(),
  sourceTarget: RoundSourceTargetSchema,
  askCount: z.number().int().positive(),
  state: RoundOperationProgressStateSchema,
});
export type RoundOperationProgressSnapshot = z.infer<typeof RoundOperationProgressSnapshotSchema>;

const doneWorkspaceProgress: { readonly status: "done" } = { status: "done" };

function doneWorkerProgress(worker: RoundWorkerCompletedReceipt): {
  readonly status: "done";
  readonly fileCount: number;
} {
  return { status: "done", fileCount: worker.changedPaths.length };
}

function doneCommitProgress(commits: RoundCommitReceipt): {
  readonly status: "done";
  readonly count: number;
} {
  return { status: "done", count: commits.count };
}

function progressFailure(
  failure: RoundOperationFailure,
): z.infer<typeof RoundOperationProgressFailureSchema> {
  switch (failure.at) {
    case "preparing":
      return {
        at: failure.at,
        workspace: { status: "failed", reason: failure.reason },
      };
    case "worker":
      return {
        at: failure.at,
        workspace: doneWorkspaceProgress,
        worker: {
          status: "failed",
          reason: failure.reason,
          ...("outcome" in failure.worker ? { fileCount: failure.worker.changedPaths.length } : {}),
        },
      };
    case "committing":
      return {
        at: failure.at,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        commits: { status: "failed", reason: failure.reason },
      };
    case "round-recording":
      return {
        at: "committing",
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        commits: { status: "failed", reason: failure.reason },
      };
    case "report-drafting":
    case "report-verifying":
      return {
        at: failure.at,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        commits: doneCommitProgress(failure.commits),
        report: {
          status: "failed",
          step: failure.at === "report-drafting" ? "drafting" : "verifying",
          reason: failure.reason,
        },
      };
  }
}

function progressState(state: RoundOperationState): RoundOperationProgressState {
  switch (state.phase) {
    case "claimed":
      return { phase: state.phase };
    case "prepared":
      return { phase: state.phase, workspace: doneWorkspaceProgress };
    case "worker-running":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: { status: "running" },
      };
    case "worker-settled":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
      };
    case "committing":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        commits: { status: "running" },
      };
    case "commits-settled":
    case "round-recording":
      return {
        phase: "committing",
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        commits: { status: "running" },
      };
    case "round-recorded":
      return {
        phase: "commits-settled",
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        commits: doneCommitProgress(state.commits),
      };
    case "report-drafting":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        commits: doneCommitProgress(state.commits),
        // The durable handoff is the report's own finish line (#728). Once it exists the
        // seats that are actually running are the lens drafters, and the surface says so.
        report:
          state.report.handoff === undefined
            ? { status: "drafting" }
            : {
                status: "handed-off",
                reportBoardId: state.report.reportBoardId,
                generation: state.report.generation,
              },
      };
    case "report-verifying":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        commits: doneCommitProgress(state.commits),
        report: {
          status: "verifying",
          reportBoardId: state.report.reportBoardId,
          generation: state.report.generation,
        },
      };
    case "completed":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        commits: doneCommitProgress(state.commits),
        result:
          state.result.kind === "unchanged"
            ? { kind: "unchanged" }
            : {
                kind: "changed",
                report: {
                  status: "verified",
                  reportBoardId: state.result.report.reportBoardId,
                  generation: state.result.report.generation,
                },
              },
      };
    case "failed":
      return { phase: state.phase, failure: progressFailure(state.failure) };
  }
}

/** Project a durable operation to the only operation data the run UI is allowed to read. */
export function roundOperationProgressSnapshot(
  operation: RoundOperation,
): RoundOperationProgressSnapshot {
  return {
    operationId: operation.operationId,
    revision: operation.revision,
    rerunRequested: operation.rerunRequested,
    draining: operation.state.phase === "completed" && operation.state.returnedAt === undefined,
    createdAt: operation.createdAt,
    roundNumber: operation.roundNumber,
    sourceTarget: operation.sourceTarget,
    askCount: operation.askOccurrences.length,
    state: progressState(operation.state),
  };
}

export function isRoundOperationTerminal(operation: RoundOperation): boolean {
  return operation.state.phase === "completed" || operation.state.phase === "failed";
}

/**
 * The rounds-ledger row (#462's #486 R57 ripple): what one work-order round
 * dispatched and what came back.
 */
export const RoundRecordSchema = z.object({
  /** Thread ids of the asks this round dispatched. */
  asksDispatched: z.array(id),
  /** Stable identity for this exact dispatch occurrence. Optional for old ledgers. */
  dispatchId: id.optional(),
  /** Patchset the work order was built from. Optional for old ledgers. */
  sourcePatchsetId: id.optional(),
  /** Exact staged occurrences consumed by a successful round. Optional for old ledgers. */
  askOccurrences: z.array(AskOccurrenceSchema).optional(),
  /** Whether board regeneration still has to resume, or this completed turn changed no code. */
  regeneration: z.enum(["pending", "not-needed"]).optional(),
  workerCommitRange: z.object({ from: id, to: id }),
  /** Generation minted from the worker's commits; absent if nothing landed. */
  mintedPatchsetGeneration: id.optional(),
  /** Patchset the real board generation describes. Optional for old ledgers. */
  resultPatchsetId: id.optional(),
  /** The FROZEN predecessor generation this round succeeded — the earlier generation the
   *  rounds ledger's `GenerationSwitcher` drills back to (C15, un-parks C09 finding F3).
   *  Present iff the code moved (a distinct id from `boardGeneration`); absent on a
   *  first-generation or no-move round — honestly, there is no distinct predecessor. */
  frozenPredecessor: id.optional(),
  /** The generation whose boards this round reported against (`ROUND_NO_REGEN` for a
   *  dispatch round that regenerated no boards). */
  boardGeneration: id,
  /** Board id of the round-report board (the `round_outcome` items live on it), or
   *  `ROUND_NO_REGEN` when the round drafted no report board. */
  reportBoard: id,
  /** Immutable run facts captured from the durable operation. Absent only on legacy rows. */
  run: RoundRunReceiptSchema.optional(),
  /** How many reworks the round actually PRODUCED, counted off the round report the
   *  drafters wrote: its `round_outcome` items that are not `untouched`. The report
   *  verifies each ask against the round's own diff, so this is the round's verified
   *  account of the work, never `asksDispatched.length` — a proxy for how many asks went
   *  OUT, which would read "5 reworks" for a round that changed nothing. Absent when the
   *  round drafted no report: then the count is honestly unknown, not zero. */
  reworkCount: z.number().int().nonnegative().optional(),
  /** The write-turn's outcome. A dispatch round records this and the diff below; the
   *  full-regeneration `runRound` path leaves them absent. */
  outcome: z.enum(["completed", "failed"]).optional(),
  /** The round's working-tree diff, captured via GitCheckpointStore — present on a
   *  dispatch round, failed rounds included (their partial edits are on disk regardless). */
  diff: z.string().optional(),
  /**
   * The same diff split per file, for the ROUND DIFF surface (#571). DERIVED at the
   * `session.rounds` read from {@link diff} through the one hardened unified-diff parser
   * (`parseUnifiedDiffFiles`, `@rennet/adapters`) — never written by a round and never
   * persisted, so the durable ledger keeps exactly one copy of the round's diff. Present
   * iff `diff` is present and parses to at least one file; absent ⇒ the round captured no
   * diff, and the ledger offers no Round-diff control at all.
   */
  diffFiles: z.array(patchFileSchema).optional(),
  /** The paths the round changed (structural, from the checkpoint's path list). */
  changedPaths: z.array(z.string()).optional(),
});
export type RoundRecord = z.infer<typeof RoundRecordSchema>;

/** A rounds-ledger read row. `report` is an exact-id read projection, never persisted. */
export const RoundLedgerRecordSchema = RoundRecordSchema.extend({
  report: RoundReportBoardSchema.optional(),
});
export type RoundLedgerRecord = z.infer<typeof RoundLedgerRecordSchema>;

/**
 * Resolve the generation the default board surface should read.
 *
 * A completed real-generation ledger row is the durable current-generation mapping after
 * a round, including after restart. `ROUND_NO_REGEN` rows changed no boards and are skipped.
 * With no real row (an initial review, or an old empty ledger), the first visit retains its
 * content-derived address so old stores and newly captured reviews continue to resolve.
 */
export function currentGenerationId(
  records: readonly RoundRecord[],
  activePatchsetId: string,
): string {
  const initial = generationIdForPatchset(activePatchsetId);
  const latest = records.findLast((record) => record.boardGeneration !== ROUND_NO_REGEN);
  if (latest?.resultPatchsetId === activePatchsetId) return latest.boardGeneration;
  if (latest?.resultPatchsetId === undefined && latest?.boardGeneration === initial) {
    return latest.boardGeneration;
  }
  return initial;
}

// ── Live round progress (C15 3.1) — the folded-progress wire ─────────────────
//
// The run machine (`app-ui/src/rounds/round-machine.ts`) is a pure fold over these
// events. They are DEFINED HERE, not in the client, because both ends speak them: the
// server emits them as a round really runs (prep → worker → gate → commit → report →
// lenses → composed), and the client folds them through `advance`. The machine's
// `RoundEvent`/`LaneRow` types are re-exports of these — one definition, so the wire and
// the reducer cannot drift.
//
// Each event carries the current SNAPSHOT of its group's rows (not a delta), so a
// duplicate or re-ordered frame just re-states rows the fold already holds.

/** A live progress row's status — the run route's queued / spinner / check, as data.
 *  `drafted` and `absent` belong only to a lens lane; step rows never reach either. */
export const RowStatusSchema = z.enum(["queued", "running", "drafted", "done", "absent", "failed"]);
export type RowStatus = z.infer<typeof RowStatusSchema>;

const laneBase = { id, label: z.string() };

/**
 * One streamed progress STEP — a prep line or the worker turn. A discriminated union on
 * `status` rather than a bag of optionals, so the illegal states are unrepresentable
 * instead of guarded at each read site: an unstarted step cannot carry an account of
 * itself, and a failed one cannot omit its reason.
 */
export const LaneRowSchema = z.discriminatedUnion("status", [
  z.object({ ...laneBase, status: z.literal("queued") }),
  z.object({ ...laneBase, status: z.literal("running") }),
  /** Settled: `detail` is the step's own account of what it did ("3 files changed"). */
  z.object({ ...laneBase, status: z.literal("done"), detail: z.string().optional() }),
  z.object({ ...laneBase, status: z.literal("failed"), reason: z.string() }),
]);
export type LaneRow = z.infer<typeof LaneRowSchema>;

/**
 * The regeneration verdict a SETTLED lens lane carries (C15 3.3). Read off the SAME
 * `stampDeltas` signal as the board's own section markers, so a lane can never claim a
 * lens carried while its sections moved.
 */
export const LaneVerdictSchema = z.enum(["carrying-forward", "reworked"]);
export type LaneVerdict = z.infer<typeof LaneVerdictSchema>;

/**
 * The T3 thread a lens seat runs on (t3-lens-threads): the address the surface uses to
 * open that seat's transcript read-only. Present from the moment the seat's thread
 * exists and kept on every later state, so a settled lens still opens its transcript.
 */
export const LaneThreadRefSchema = z.object({ environmentId: z.string(), threadId: z.string() });
export type LaneThreadRef = z.infer<typeof LaneThreadRefSchema>;

/**
 * The newest thing a running seat is doing, projected from its thread in plain words:
 * a tool call in flight ("reading src/foo.ts"), the last sentence of the agent's own
 * text, or `idle` when the thread has been quiet (the text then says for how long). `at`
 * is the daemon's clock when the projection was made, so a stale line can be told from
 * a fresh one.
 */
export const LaneLatestSchema = z.object({
  kind: z.enum(["tool", "text", "idle"]),
  text: z.string(),
  at: z.number(),
});
export type LaneLatest = z.infer<typeof LaneLatestSchema>;

/**
 * One SEAT on a lane. Most lanes run one; Flagged runs two (a Claude seat and a Codex
 * seat, reconciled into one board), and each has its own thread and its own live line.
 * A lane's top-level `thread`/`latest` mirror `seats[0]` (the PRIMARY seat) so readers
 * of the single-seat shape keep working for one release; new readers read `seats`.
 */
export const LaneSeatSchema = z.object({
  seat: z.string(),
  provider: z.enum(["claudeAgent", "codex"]),
  thread: LaneThreadRefSchema.optional(),
  latest: LaneLatestSchema.optional(),
});
export type LaneSeat = z.infer<typeof LaneSeatSchema>;

const lensLaneBase = {
  ...laneBase,
  thread: LaneThreadRefSchema.optional(),
  seats: z.array(LaneSeatSchema).optional(),
};

/**
 * One lens drafter's lane in the regeneration block. Same discipline as {@link
 * LaneRowSchema}, with the verdict bound to the state that can HAVE one: `queued` and
 * `running` carry no verdict because none has been computed; `drafted` is the real window
 * between a board's draft landing and its arrival (cross-lens coverage runs in between,
 * and the verdict rides the arrival); `done` REQUIRES the verdict; `absent` records a
 * successful no-material result; `failed` requires the drafter's reason. There is no
 * representable "settled lane with no verdict". Only `running` carries `latest`: a settled
 * lane has nothing in flight.
 */
export const LensLaneSchema = z.discriminatedUnion("status", [
  z.object({ ...lensLaneBase, status: z.literal("queued") }),
  z.object({ ...lensLaneBase, status: z.literal("running"), latest: LaneLatestSchema.optional() }),
  z.object({ ...lensLaneBase, status: z.literal("drafted") }),
  z.object({ ...lensLaneBase, status: z.literal("done"), verdict: LaneVerdictSchema }),
  z.object({ ...lensLaneBase, status: z.literal("absent"), reason: z.string() }),
  z.object({ ...lensLaneBase, status: z.literal("failed"), reason: z.string() }),
]);
export type LensLane = z.infer<typeof LensLaneSchema>;

/**
 * The durable preparation state for a session opened from New Chat. The session is minted
 * before capture starts so the client can navigate immediately; this record is the honest
 * account of what the daemon is doing after that navigation. Board lanes are snapshots folded
 * from the real lens-pipeline events, not client timers.
 */
export const SessionPreparationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("capturing"),
    step: z.enum(["resolving-repository", "capturing-change"]),
  }),
  z.object({
    status: z.literal("drafting"),
    reviewId: id,
    lanes: z.array(LensLaneSchema),
  }),
  z.object({
    status: z.literal("failed"),
    stage: z.enum(["capture", "boards"]),
    reason: z.string().min(1),
    reviewId: id.optional(),
    lanes: z.array(LensLaneSchema).optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
    stage: z.enum(["capture", "boards"]),
    reviewId: id.optional(),
    lanes: z.array(LensLaneSchema).optional(),
  }),
]);
export type SessionPreparation = z.infer<typeof SessionPreparationSchema>;

/**
 * The event's position in its review's progress log — monotonic across rounds, assigned
 * by the emitting hub. It exists so a client can MERGE the catch-up read with the live
 * push without either clobbering the other: an event already folded is recognised by its
 * `seq` and dropped, and everything before the newest `dispatched` belongs to a round
 * that is over, so a late terminal event from it cannot settle the round now running.
 *
 * Optional on the wire: a daemon that predates the sequence emits none, and a client
 * folds those in arrival order exactly as before — the honest degrade, not a handshake.
 */
const seq = z.number().int().nonnegative().optional();

const diagnosticElapsedMs = z.number().int().nonnegative();
const diagnosticEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly CouncilEffort[];
const claudeDiagnosticModels = [
  "haiku",
  "sonnet-5",
  "opus-4.8",
] as const satisfies readonly CouncilModel[];
const codexDiagnosticModels = [
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const satisfies readonly CouncilModel[];

const RoundReportTurnStartedMilestoneSchema = z.union([
  z
    .object({
      stage: z.literal("turn-started"),
      harness: z.literal("claude-code"),
      model: z.enum(claudeDiagnosticModels),
      effort: z.enum(diagnosticEfforts),
      elapsedMs: diagnosticElapsedMs,
    })
    .strict(),
  z
    .object({
      stage: z.literal("turn-started"),
      harness: z.literal("codex"),
      model: z.enum(codexDiagnosticModels),
      effort: z.enum(diagnosticEfforts),
      elapsedMs: diagnosticElapsedMs,
    })
    .strict(),
]);

/** Content-free checkpoints for one classified report turn. The fixed vocabularies and
 * elapsed integer are the complete payload; provider text and review material cannot fit. */
export const RoundReportDiagnosticMilestoneSchema = z.union([
  RoundReportTurnStartedMilestoneSchema,
  z
    .object({
      stage: z.literal("provider-settled"),
      outcome: z.enum([
        "completed",
        "failed",
        "cancelled",
        "stream-ended-without-terminal",
        "threw",
      ]),
      elapsedMs: diagnosticElapsedMs,
    })
    .strict(),
  z
    .object({
      stage: z.literal("turn-settled"),
      status: z.enum(["emitted", "failed"]),
      elapsedMs: diagnosticElapsedMs,
    })
    .strict(),
  z.object({ stage: z.literal("schema-parsed"), elapsedMs: diagnosticElapsedMs }).strict(),
  z.object({ stage: z.literal("evidence-verified"), elapsedMs: diagnosticElapsedMs }).strict(),
  z.object({ stage: z.literal("persisted"), elapsedMs: diagnosticElapsedMs }).strict(),
]);
export type RoundReportDiagnosticMilestone = z.infer<typeof RoundReportDiagnosticMilestoneSchema>;

/**
 * One folded round-progress event. The server emits these from REAL round progress —
 * never a clock — and the client's `advance` walks the phases off them. `failed` is the
 * terminal arm: a crashed worker or a broken regeneration emits it, so a stalled round
 * surfaces as a failure rather than silence.
 */
const LegacyRoundReportEventSchema = z.object({
  type: z.literal("report"),
  reportBoardId: id,
  operationId: z.never().optional(),
  operationRevision: z.never().optional(),
  report: z.never().optional(),
  seq,
});

const ScopedRoundReportEventSchema = z.object({
  type: z.literal("report"),
  reportBoardId: id,
  operationId: id,
  operationRevision: z.number().int().nonnegative(),
  /** The already-validated report projection, readable before lens drafting settles. */
  report: RoundReportBoardSchema,
  seq,
});

const LegacyRoundLensEventSchema = z.object({
  type: z.literal("lens"),
  lanes: z.array(LensLaneSchema),
  /** Cumulative seat spend so far, riding the same frame as the lanes (#737). */
  usage: GenerationUsageSchema.optional(),
  operationId: z.never().optional(),
  operationRevision: z.never().optional(),
  seq,
});

const ScopedRoundLensEventSchema = z.object({
  type: z.literal("lens"),
  lanes: z.array(LensLaneSchema),
  /** Cumulative seat spend so far, riding the same frame as the lanes (#737). */
  usage: GenerationUsageSchema.optional(),
  operationId: id,
  operationRevision: z.number().int().nonnegative(),
  seq,
});

const LegacyRoundReportDiagnosticEventSchema = z.object({
  type: z.literal("report-diagnostic"),
  milestone: RoundReportDiagnosticMilestoneSchema,
  operationId: z.never().optional(),
  operationRevision: z.never().optional(),
  seq,
});

const ScopedRoundReportDiagnosticEventSchema = z.object({
  type: z.literal("report-diagnostic"),
  milestone: RoundReportDiagnosticMilestoneSchema,
  operationId: id,
  operationRevision: z.number().int().nonnegative(),
  seq,
});

const BasicRoundEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("operation"),
    snapshot: RoundOperationProgressSnapshotSchema,
    seq,
  }),
  z.object({ type: z.literal("dispatched"), seq }),
  z.object({ type: z.literal("prep"), rows: z.array(LaneRowSchema), seq }),
  z.object({ type: z.literal("worker"), rows: z.array(LaneRowSchema), seq }),
  z.object({ type: z.literal("committed"), seq }),
  z.object({ type: z.literal("composed"), generation: id, seq }),
  /** The worker completed but its checkpoint was empty, so no generation was regenerated. */
  z.object({ type: z.literal("unchanged"), seq }),
  z.object({ type: z.literal("failed"), reason: z.string(), seq }),
]);
export const RoundEventSchema = z.union([
  BasicRoundEventSchema,
  LegacyRoundReportEventSchema,
  ScopedRoundReportEventSchema,
  LegacyRoundLensEventSchema,
  ScopedRoundLensEventSchema,
  LegacyRoundReportDiagnosticEventSchema,
  ScopedRoundReportDiagnosticEventSchema,
]);
export type RoundEvent = z.infer<typeof RoundEventSchema>;

/**
 * The chat dock's header trail (C07) — the session's identity line. Honest-minimal:
 * the coding transcript lives in the harness, so this carries only the identity facts
 * Rennet holds. `target`/`targetState` mirror the sidebar's review-target vocabulary.
 */
export const SessionTrailSchema = z.object({
  title: z.string(),
  projectName: z.string().optional(),
  /**
   * The workspace the session is bound to (session-bound-workspace): the path every one of
   * its turns runs in, shown beside the branch so the reviewer can see WHICH checkout a seat
   * read. A host path, scrubbed to a `<root>`/`~` reference for a projected connection by the
   * same wire projection every other path crosses. Absent ⇒ nothing has bound a workspace
   * yet, and the trail says nothing rather than naming a root it cannot prove.
   */
  workspace: z.string().optional(),
  target: z.enum(["your-branch", "your-pr", "teammate-pr"]).optional(),
  targetState: z.enum(["needs-you", "merged", "reviewed"]).optional(),
});
export type SessionTrail = z.infer<typeof SessionTrailSchema>;

/**
 * A harness-reported context-window figure (ask-don't-estimate, #466 res. 3). Absent on
 * the wire ⇒ the meter reads "unknown"; never estimated. Both figures are the harness's own.
 */
export const SessionContextWindowSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type SessionContextWindow = z.infer<typeof SessionContextWindowSchema>;

// A turn/block lifecycle. Inlined (not imported from `../wire`) to keep this leaf shapes
// module off the root-index import cycle `wire.ts` sits on — three literals, cheap to hold.
const transcriptTurnStatus = z.enum(["streaming", "complete", "interrupted"]);

/**
 * A collapsing "Thinking → Thought" block projected from the harness's reasoning events
 * (B). Its live/settled look follows `status`; `text` is the reasoning, one entry per line.
 */
export const ThoughtBlockSchema = z.object({
  kind: z.literal("thought"),
  id,
  status: transcriptTurnStatus,
  seconds: z.number().nonnegative().optional(),
  text: z.array(z.string()),
});

/**
 * A running → done tool-call step, projected from a `tool.started` joined with its
 * `tool.output` (B). `toolKind` is the SERIALIZABLE icon selector — the client maps it to a
 * concrete icon (C07); the wire never carries a component. `denied` marks a `tool.denied`.
 * Path-bearing strings are stored verbatim; R19 scrubs them at the wire, for a remote client only.
 */
export const ActionStepSchema = z.object({
  kind: z.literal("action"),
  id,
  label: z.string(),
  detail: z.string().optional(),
  status: transcriptTurnStatus,
  doneLabel: z.string().optional(),
  doneDetail: z.string().optional(),
  toolKind: z.enum(["read", "write", "exec", "search", "mcp", "subagent", "other"]),
  denied: z.boolean().optional(),
});

/** A turn's activity preface: thought blocks and action steps, in occurrence order. */
export const ActivityStepSchema = z.discriminatedUnion("kind", [
  ThoughtBlockSchema,
  ActionStepSchema,
]);
export type ActivityStep = z.infer<typeof ActivityStepSchema>;

export const ProseBlockSchema = z.object({ kind: z.literal("text"), text: z.string() });
export const CodeBlockSchema = z.object({
  kind: z.literal("code"),
  path: z.string(),
  lang: z.string().optional(),
  code: z.string(),
  startLine: z.number().int().optional(),
  highlightLines: z.array(z.number().int()).optional(),
});
/** A turn body: prose interleaved with code blocks. */
export const ContentBlockSchema = z.discriminatedUnion("kind", [ProseBlockSchema, CodeBlockSchema]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * The lossless display order for a transcript turn. `preface` and `body` remain on the
 * persisted row for older clients and stored rows; new projectors also write this one stream
 * so prose between harness activity does not move when the row is reconstructed.
 */
export const TranscriptBlockSchema = z.discriminatedUnion("kind", [
  ThoughtBlockSchema,
  ActionStepSchema,
  ProseBlockSchema,
  CodeBlockSchema,
]);
export type TranscriptBlock = z.infer<typeof TranscriptBlockSchema>;

/**
 * A session-transcript row. The harness CLI stays the CANONICAL owner of the conversation —
 * resume still rides the `HarnessCursor` (#466 res. 3), untouched. This is ADDITIVE to that:
 * a DISPLAY read-model projected from the harness events the adapter already normalizes
 * (tool calls, outputs, thinking, prose), persisted so the dock shows history and survives
 * reload. Three representable rows:
 *   - `turn`: one coding turn — orchestrator (or user) — with its thought/action preface and
 *     its prose/code body. Path-bearing content is stored verbatim and scrubbed at the wire.
 *   - `compact-boundary`: the harness summarized in place; its own figures, absent ⇒ unknown.
 *   - `context-rebuilt`: the harness lost the transcript and Rennet rebuilt from the boards.
 */
export const SessionTranscriptRowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    id,
    speaker: z.enum(["user", "orchestrator"]),
    status: transcriptTurnStatus,
    paragraphs: z.array(z.string()),
    time: z.string().optional(),
    lead: z.string().optional(),
    preface: z.array(ActivityStepSchema).optional(),
    body: z.array(ContentBlockSchema).optional(),
    /** Ordered additive representation; absent on transcript rows persisted before #620. */
    blocks: z.array(TranscriptBlockSchema).optional(),
  }),
  z.object({
    kind: z.literal("compact-boundary"),
    id,
    time: z.string().optional(),
    tokensBefore: z.number().int().nonnegative().optional(),
    tokensAfter: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("context-rebuilt"), id, reason: z.string() }),
]);
export type SessionTranscriptRow = z.infer<typeof SessionTranscriptRowSchema>;

/**
 * The chat dock's session read (C07): the header trail, the historical transcript rows, and the
 * harness context figure. `rows` carries the coding turns the session turn loop captured and
 * persisted, and is honestly `[]` for a session that has run none. `contextWindow` stays absent —
 * no read port reports one, and Rennet never estimates a token budget. The live ask threads
 * arrive separately via `review.reattach`.
 */
export const SessionTranscriptSchema = z.object({
  trail: SessionTrailSchema,
  rows: z.array(SessionTranscriptRowSchema),
  contextWindow: SessionContextWindowSchema.optional(),
});
export type SessionTranscript = z.infer<typeof SessionTranscriptSchema>;

/**
 * The session (#466 res. 1–2): the first-class durable root. One chat travels
 * with the reviewer across surfaces; it owns the harness cursor, the threads,
 * and the claim. A review attaches 1:0..1 (`reviewId` — referenced, not
 * absorbed); a no-target session has no claim and upgrades in place when a
 * target binds. Archive is the only release (v1 soft delete).
 */
export const SessionModelSchema = z
  .object({
    id,
    projectId: id,
    /**
     * The repository root the session's work actually runs in (#580). `projectId` is the
     * SIDEBAR GROUPING key — a `Project.id` — and a workspace project holds MANY repos, so
     * that mapping is many-to-one and NOT invertible: the project id alone cannot say which
     * repo a round ran in. This is where the session keeps it, so per-repo rounds in one
     * workspace never collapse into a single ledger. Absent until something that KNOWS the
     * root stamps it (a round dispatch does; a New Chat row click does not know which repo
     * of a workspace it named), and a later dispatch stamps it in place.
     */
    repositoryRoot: z.string().min(1).optional(),
    /**
     * The ONE workspace this session is bound to (session-bound-workspace D1): the reviewer's
     * own checkout when it sits on the reviewed branch, a Rennet-created worktree for the
     * branch when it does not, the PR worktree for a snapshot. Decided once, from the review
     * target, and kept for the session's whole life — every child of the session runs here:
     * each lens seat thread, the chat thread, the handoff thread, the round worker, and every
     * cold utility turn. It is also where the session's `.rennet/context/<id>` directory
     * lives, so the archive purge aims at the root the files are actually under.
     *
     * Distinct from `repositoryRoot`, which names the REPOSITORY the target lives in: for an
     * off-branch or PR-snapshot review the bound root is a worktree of that repository, not
     * the repository itself.
     *
     * Absent ⇒ minted before the binding wave, or nothing has needed the workspace yet; the
     * first use binds lazily and records it (D migration step 4), and until then reads fall
     * back to `repositoryRoot` then the attached review's root.
     */
    boundRoot: z.string().min(1).optional(),
    /**
     * The `owner/name` identity of the repo this session's target lives in (#580). NOT a path —
     * it is the same stable identity `LocalWork.repository`/`PullRequest.repository` carry (the
     * origin remote, else the durable common-dir alias), so it crosses the wire freely where
     * `repositoryRoot` never could.
     *
     * It exists because a New Chat row knows this and cannot know the root: without it, two repos
     * in one workspace that both have a `main` branch mint ONE session and clicking one row hands
     * you the other's chat. Absent ⇒ the caller did not name a repository, and matching behaves
     * exactly as it did before this field existed.
     */
    repository: z.string().min(1).optional(),
    /** Provider-qualified repository identity for new sessions. Optional so the durable store
     * still loads sessions written before provider identity existed. */
    forgeRepository: forgeRepoIdentitySchema.optional(),
    claim: ClaimSchema.optional(),
    reviewId: id.optional(),
    /** Present while New Chat capture/board preparation is running or when it stopped before
     * completion. Cleared only after the attached review's first generation settles. */
    preparation: SessionPreparationSchema.optional(),
    /**
     * The harness selected for this session's coding rounds. The first dispatch resolves one
     * enabled installed harness and persists it; later rounds resolve this exact id or fail.
     */
    codingHarness: CodingHarnessSelectionSchema.optional(),
    harnessCursor: HarnessCursorSchema.optional(),
    threads: z.array(SessionThreadSchema),
    createdAt: z.number(),
    archivedAt: z.number().optional(),
    /**
     * The reviewer's own title for this session (C18 `session.rename`). Additive-optional:
     * an unnamed session has none and the sidebar falls back to the claimed branch, so
     * clearing a title RESTORES that fallback rather than persisting an empty label.
     */
    title: z.string().min(1).optional(),
    /** Pinned to the top of its project group (C18 `session.setPinned`); absent ⇒ unpinned. */
    pinned: z.boolean().optional(),
  })
  .refine((session) => forgeRepositoryMatchesLegacy(session.repository, session.forgeRepository), {
    path: ["forgeRepository"],
    message: "forgeRepository must name the same owner/name as repository",
  });
export type SessionModel = z.infer<typeof SessionModelSchema>;
