// The durable-session shapes (#466 resolution, 2026-08-26; #457 vocabulary).
//
// Shapes only: the state machine, locks, and rework queue are B9's; dispatch
// binding is B4/B10's. The transport wire layer lives beside this in
// `wire.ts` (#376) — two session contracts, one folder seam.

import { z } from "zod";
import { AskLifecycleSchema, generationIdForPatchset, QuoteAnchorSchema } from "../board";
// Thread anchors cite code through the canonical CodeRef (delta/citations, B3 task 6.2).
import { codeRefSchema, patchFileSchema } from "../delta/citations";
import { LENS_KINDS } from "../manifests";
import { sha256Hex } from "../sha256";

const id = z.string().min(1);

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

/**
 * A generation (#457): one immutable visit to a review's boards over a patchset.
 * `patchsetId` identifies the content; `id` distinguishes later visits to the same
 * content. Live boards are append-only logs; when the code moves, the generation
 * freezes immutable and a successor is minted — the successor account compares N vs N+1.
 */
export const LensAbsenceReasonSchema = z.enum(["no-material"]);
export type LensAbsenceReason = z.infer<typeof LensAbsenceReasonSchema>;

export const GenerationSchema = z.object({
  id,
  patchsetId: id,
  /** Per-lens draft boards (L2), keyed by lens; present once drafted. */
  lensBoards: z.partialRecord(z.enum(LENS_KINDS), id),
  /** Pre-minted ids for the one drafting attempt currently allowed to write BoardMeta. */
  draftingBoardIds: z.partialRecord(z.enum(LENS_KINDS), id).optional(),
  /** The current attempt's exact report slot. Presence does not claim the report drafted. */
  draftingReportBoardId: id.optional(),
  /** Successful per-lens absences, distinct from a board that has not arrived yet. */
  absentLenses: z.partialRecord(z.enum(LENS_KINDS), LensAbsenceReasonSchema).optional(),
  /** The orchestrator-authored composition board (L3), once composed. */
  compositionBoardId: id.optional(),
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

/** The detached execution locus and exact reviewed tree reserved before creation starts.
 * Persisting both source objects first lets restart recovery recreate the same synthetic
 * source commit even when the source checkout had uncommitted reviewed changes. */
export const RoundWorkspaceAttemptSchema = z.object({
  kind: z.literal("detached-worktree"),
  worktreePath: id,
  sourceTreeOid: id,
  sourceParentHead: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundWorkspaceAttempt = z.infer<typeof RoundWorkspaceAttemptSchema>;

/** The detached execution locus prepared for one round. Its source commit is the exact
 * reviewed tree/checkpoint the work order was composed against, never ambient checkout HEAD. */
export const RoundWorkspaceReceiptSchema = RoundWorkspaceAttemptSchema.extend({
  sourceHead: id,
  preparedAt: z.number().int().nonnegative(),
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

export const RoundGateAttemptSchema = z.object({
  executionId: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundGateAttempt = z.infer<typeof RoundGateAttemptSchema>;

const completedGateBase = {
  ...RoundGateAttemptSchema.shape,
  completedAt: z.number().int().nonnegative(),
  /** Number of project tasks the configured gate reported, when the gate can count them. */
  projectCount: z.number().int().nonnegative().optional(),
};

export const RoundGatePassedReceiptSchema = z.object({
  ...completedGateBase,
  outcome: z.literal("passed"),
  exitCode: z.literal(0),
});
export type RoundGatePassedReceipt = z.infer<typeof RoundGatePassedReceiptSchema>;

export const RoundGateFailedReceiptSchema = z.object({
  ...completedGateBase,
  outcome: z.literal("failed"),
  termination: RoundTerminationSchema,
});
export type RoundGateFailedReceipt = z.infer<typeof RoundGateFailedReceiptSchema>;

export const RoundGateSkippedReceiptSchema = z.object({
  outcome: z.literal("skipped"),
  reason: z.literal("not-configured"),
  settledAt: z.number().int().nonnegative(),
});
export type RoundGateSkippedReceipt = z.infer<typeof RoundGateSkippedReceiptSchema>;

/** The configured repository gate's process result, not a UI inference. */
export const RoundGateReceiptSchema = z.discriminatedUnion("outcome", [
  RoundGatePassedReceiptSchema,
  RoundGateFailedReceiptSchema,
  RoundGateSkippedReceiptSchema,
]);
export type RoundGateReceipt = z.infer<typeof RoundGateReceiptSchema>;

export const RoundGateSettledReceiptSchema = z.discriminatedUnion("outcome", [
  RoundGatePassedReceiptSchema,
  RoundGateSkippedReceiptSchema,
]);
export type RoundGateSettledReceipt = z.infer<typeof RoundGateSettledReceiptSchema>;

export const RoundCommitAttemptSchema = z.object({
  executionId: id,
  baseHead: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundCommitAttempt = z.infer<typeof RoundCommitAttemptSchema>;

/** The commits observed after the worker and gate settle. Equal endpoints with count zero
 * are an honest no-commit result; a nonzero count is derived from Git. */
export const RoundCommitReceiptSchema = z.object({
  ...RoundCommitAttemptSchema.shape,
  from: id,
  to: id,
  count: z.number().int().nonnegative(),
  committedAt: z.number().int().nonnegative(),
});
export type RoundCommitReceipt = z.infer<typeof RoundCommitReceiptSchema>;

export const RoundSourceLandingAttemptSchema = z.object({
  effect: z.literal("source-landing"),
  executionId: id,
  baselineCommit: id,
  workerHead: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundSourceLandingAttempt = z.infer<typeof RoundSourceLandingAttemptSchema>;

const roundSourceLandingReceiptBase = {
  ...RoundSourceLandingAttemptSchema.shape,
  landedAt: z.number().int().nonnegative(),
};

export const RoundSourceLandingReceiptSchema = z.discriminatedUnion("outcome", [
  z.object({ ...roundSourceLandingReceiptBase, outcome: z.literal("unchanged") }),
  z.object({ ...roundSourceLandingReceiptBase, outcome: z.literal("applied") }),
  z.object({ ...roundSourceLandingReceiptBase, outcome: z.literal("already-applied") }),
]);
export type RoundSourceLandingReceipt = z.infer<typeof RoundSourceLandingReceiptSchema>;

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

export const RoundReportDraftAttemptSchema = z.object({
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
  startedAt: z.number().int().nonnegative(),
});
export type RoundReportDraftAttempt = z.infer<typeof RoundReportDraftAttemptSchema>;

export const RoundReportDraftReceiptSchema = RoundReportDraftAttemptSchema.extend({
  draftedAt: z.number().int().nonnegative(),
});
export type RoundReportDraftReceipt = z.infer<typeof RoundReportDraftReceiptSchema>;

export const RoundReportVerificationAttemptSchema = z.object({
  executionId: id,
  startedAt: z.number().int().nonnegative(),
});
export type RoundReportVerificationAttempt = z.infer<typeof RoundReportVerificationAttemptSchema>;

/** A report is complete only once the durable board named here has been verified readable. */
export const RoundReportReceiptSchema = RoundReportDraftReceiptSchema.extend({
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
  z.object({
    at: z.literal("preparing"),
    ...failureBase,
    workspace: RoundWorkspaceAttemptSchema,
  }),
  z.object({
    at: z.literal("worker"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: z.union([RoundWorkerFailedReceiptSchema, RoundWorkerAttemptSchema]),
  }),
  z.object({
    at: z.literal("gate"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: z.union([RoundGateFailedReceiptSchema, RoundGateAttemptSchema]),
  }),
  z.object({
    at: z.literal("committing"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commit: RoundCommitAttemptSchema,
  }),
  z.object({
    at: z.literal("source-landing"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingAttemptSchema,
  }),
  z.object({
    at: z.literal("round-recording"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingAttemptSchema,
  }),
  z.object({
    at: z.literal("report-drafting"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftAttemptSchema,
  }),
  z.object({
    at: z.literal("report-verifying"),
    ...failureBase,
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
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
  z.object({ phase: z.literal("workspace-preparing"), workspace: RoundWorkspaceAttemptSchema }),
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
    phase: z.literal("gate-running"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateAttemptSchema,
  }),
  z.object({
    phase: z.literal("gate-settled"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
  }),
  z.object({
    phase: z.literal("committing"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commit: RoundCommitAttemptSchema,
  }),
  z.object({
    phase: z.literal("commits-settled"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
  }),
  z.object({
    phase: z.literal("source-landing"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingAttemptSchema,
  }),
  z.object({
    phase: z.literal("source-landed"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
  }),
  z.object({
    phase: z.literal("round-recording"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingAttemptSchema,
  }),
  z.object({
    phase: z.literal("round-recorded"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingReceiptSchema,
  }),
  z.object({
    phase: z.literal("report-drafting"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftAttemptSchema,
  }),
  z.object({
    phase: z.literal("report-verifying"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    report: RoundReportDraftReceiptSchema,
    verification: RoundReportVerificationAttemptSchema,
  }),
  z.object({
    phase: z.literal("completed"),
    workspace: RoundWorkspaceReceiptSchema,
    worker: RoundWorkerCompletedReceiptSchema,
    gate: RoundGateSettledReceiptSchema,
    commits: RoundCommitReceiptSchema,
    landing: RoundSourceLandingReceiptSchema,
    recording: RoundRecordingReceiptSchema,
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("changed"), report: RoundReportReceiptSchema }),
      z.object({ kind: z.literal("unchanged") }),
    ]),
    completedAt: z.number().int().nonnegative(),
  }),
  z.object({
    phase: z.literal("failed"),
    failure: RoundOperationFailureSchema,
  }),
]);
export type RoundOperationState = z.infer<typeof RoundOperationStateSchema>;

export const RoundSourceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), branch: id }),
  z.object({ kind: z.literal("detached"), head: id }),
]);
export type RoundSourceTarget = z.infer<typeof RoundSourceTargetSchema>;

export const RoundGatePlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("configured"), command: z.string().min(1) }),
  z.object({ kind: z.literal("absent") }),
]);
export type RoundGatePlan = z.infer<typeof RoundGatePlanSchema>;

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
    workOrderDigest: z.string().regex(/^[a-f0-9]{64}$/),
    gatePlan: RoundGatePlanSchema,
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
    const failure = state.phase === "failed" ? state.failure : undefined;
    const gate =
      state.phase !== "failed" && "gate" in state
        ? state.gate
        : failure !== undefined && "gate" in failure
          ? failure.gate
          : undefined;
    if (
      operation.gatePlan.kind === "absent" &&
      (state.phase === "gate-running" ||
        failure?.at === "gate" ||
        (gate !== undefined && ("outcome" in gate ? gate.outcome !== "skipped" : true)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "gate"],
        message: "gate evidence contradicts the absent gate plan",
      });
    }
    if (
      operation.gatePlan.kind === "configured" &&
      gate !== undefined &&
      "outcome" in gate &&
      gate.outcome === "skipped"
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "gate"],
        message: "configured gate cannot be skipped as not configured",
      });
    }
    const workspace =
      state.phase !== "failed" && "workspace" in state
        ? state.workspace
        : failure !== undefined && "workspace" in failure
          ? failure.workspace
          : undefined;
    if (
      operation.sourceTarget.kind === "detached" &&
      workspace !== undefined &&
      workspace.sourceParentHead !== operation.sourceTarget.head
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "workspace", "sourceParentHead"],
        message: "does not match the detached source parent head",
      });
    }
    const commits =
      state.phase !== "failed" && "commits" in state
        ? state.commits
        : failure !== undefined && "commits" in failure
          ? failure.commits
          : undefined;
    const landing =
      state.phase !== "failed" && "landing" in state
        ? state.landing
        : failure !== undefined && "landing" in failure
          ? failure.landing
          : undefined;
    const settledWorker =
      state.phase !== "failed" &&
      "worker" in state &&
      "outcome" in state.worker &&
      state.worker.outcome === "completed"
        ? state.worker
        : failure !== undefined &&
            "worker" in failure &&
            "outcome" in failure.worker &&
            failure.worker.outcome === "completed"
          ? failure.worker
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
    if (commits !== undefined && commits.baseHead !== commits.from) {
      context.addIssue({
        code: "custom",
        path: ["state", "commits", "baseHead"],
        message: "does not match the observed commit range start",
      });
    }
    if (
      commits !== undefined &&
      landing !== undefined &&
      (landing.baselineCommit !== commits.from || landing.workerHead !== commits.to)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "landing"],
        message: "does not match the settled commit range",
      });
    }
    if (
      commits !== undefined &&
      landing !== undefined &&
      "outcome" in landing &&
      settledWorker !== undefined &&
      ((hasChangedRoundEvidence(settledWorker, commits) && landing.outcome === "unchanged") ||
        (!hasChangedRoundEvidence(settledWorker, commits) && landing.outcome !== "unchanged"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "landing", "outcome"],
        message: "contradicts the settled worker and commit evidence",
      });
    }
  });
export type RoundOperation = z.infer<typeof RoundOperationSchema>;

// The run screen receives a redacted projection of the durable operation. These stage
// receipts contain only facts the UI renders. Local paths, prompts, diffs, changed paths,
// commit hashes, execution ids, and repository/session identities stay server-side.
const runningWorkspace = z.object({ status: z.literal("running") });
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

const runningGate = z.object({ status: z.literal("running") });
const passedGate = z.object({
  status: z.literal("passed"),
  durationMs: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative().optional(),
});
const skippedGate = z.object({
  status: z.literal("skipped"),
  reason: z.literal("not-configured"),
});
const failedGate = z.object({
  status: z.literal("failed"),
  reason: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative().optional(),
});
const settledGate = z.discriminatedUnion("status", [passedGate, skippedGate]);

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
const verifyingReport = z.object({ status: z.literal("verifying") });
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
    at: z.literal("gate"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: failedGate,
  }),
  z.object({
    at: z.literal("committing"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: failedCommits,
  }),
  z.object({
    at: z.literal("report-drafting"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: settledCommits,
    report: failedReport,
  }),
  z.object({
    at: z.literal("report-verifying"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: settledCommits,
    report: failedReport,
  }),
]);

/** Redacted durable operation state. Every arm carries all settled receipts before it. */
export const RoundOperationProgressStateSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("claimed") }),
  z.object({
    phase: z.literal("workspace-preparing"),
    workspace: runningWorkspace,
  }),
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
    phase: z.literal("gate-running"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: runningGate,
  }),
  z.object({
    phase: z.literal("gate-settled"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
  }),
  z.object({
    phase: z.literal("committing"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: runningCommits,
  }),
  z.object({
    phase: z.literal("commits-settled"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: settledCommits,
  }),
  z.object({
    phase: z.literal("report-drafting"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: settledCommits,
    report: draftingReport,
  }),
  z.object({
    phase: z.literal("report-verifying"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
    commits: settledCommits,
    report: verifyingReport,
  }),
  z.object({
    phase: z.literal("completed"),
    workspace: settledWorkspace,
    worker: settledWorker,
    gate: settledGate,
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
  createdAt: z.number().int().nonnegative(),
  roundNumber: z.number().int().positive(),
  sourceTarget: RoundSourceTargetSchema,
  askCount: z.number().int().positive(),
  gatePlan: RoundGatePlanSchema,
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

function gateDurationMs(gate: RoundGatePassedReceipt | RoundGateFailedReceipt): number {
  return Math.max(0, gate.completedAt - gate.startedAt);
}

function settledGateProgress(gate: RoundGateSettledReceipt):
  | {
      readonly status: "passed";
      readonly durationMs: number;
      readonly projectCount?: number;
    }
  | { readonly status: "skipped"; readonly reason: "not-configured" } {
  if (gate.outcome === "skipped") return { status: "skipped", reason: gate.reason };
  return {
    status: "passed",
    durationMs: gateDurationMs(gate),
    ...(gate.projectCount === undefined ? {} : { projectCount: gate.projectCount }),
  };
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
    case "gate":
      return {
        at: failure.at,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        gate: {
          status: "failed",
          reason: failure.reason,
          durationMs:
            "outcome" in failure.gate
              ? gateDurationMs(failure.gate)
              : Math.max(0, failure.failedAt - failure.gate.startedAt),
          ...("outcome" in failure.gate && failure.gate.projectCount !== undefined
            ? { projectCount: failure.gate.projectCount }
            : {}),
        },
      };
    case "committing":
      return {
        at: failure.at,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        gate: settledGateProgress(failure.gate),
        commits: { status: "failed", reason: failure.reason },
      };
    case "source-landing":
    case "round-recording":
      return {
        at: "committing",
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        gate: settledGateProgress(failure.gate),
        commits: { status: "failed", reason: failure.reason },
      };
    case "report-drafting":
    case "report-verifying":
      return {
        at: failure.at,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(failure.worker),
        gate: settledGateProgress(failure.gate),
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
    case "workspace-preparing":
      return { phase: state.phase, workspace: { status: "running" } };
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
    case "gate-running":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: { status: "running" },
      };
    case "gate-settled":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
      };
    case "committing":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
        commits: { status: "running" },
      };
    case "commits-settled":
    case "source-landing":
    case "source-landed":
    case "round-recording":
      return {
        phase: "committing",
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
        commits: { status: "running" },
      };
    case "round-recorded":
      return {
        phase: "commits-settled",
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
        commits: doneCommitProgress(state.commits),
      };
    case "report-drafting":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
        commits: doneCommitProgress(state.commits),
        report: { status: "drafting" },
      };
    case "report-verifying":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
        commits: doneCommitProgress(state.commits),
        report: { status: "verifying" },
      };
    case "completed":
      return {
        phase: state.phase,
        workspace: doneWorkspaceProgress,
        worker: doneWorkerProgress(state.worker),
        gate: settledGateProgress(state.gate),
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
    createdAt: operation.createdAt,
    roundNumber: operation.roundNumber,
    sourceTarget: operation.sourceTarget,
    askCount: operation.askOccurrences.length,
    gatePlan: operation.gatePlan,
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
 * One lens drafter's lane in the regeneration block. Same discipline as {@link
 * LaneRowSchema}, with the verdict bound to the state that can HAVE one: `queued` and
 * `running` carry no verdict because none has been computed; `drafted` is the real window
 * between a board's draft landing and its arrival (cross-lens coverage runs in between,
 * and the verdict rides the arrival); `done` REQUIRES the verdict; `absent` records a
 * successful no-material result; `failed` requires the drafter's reason. There is no
 * representable "settled lane with no verdict".
 */
export const LensLaneSchema = z.discriminatedUnion("status", [
  z.object({ ...laneBase, status: z.literal("queued") }),
  z.object({ ...laneBase, status: z.literal("running") }),
  z.object({ ...laneBase, status: z.literal("drafted") }),
  z.object({ ...laneBase, status: z.literal("done"), verdict: LaneVerdictSchema }),
  z.object({ ...laneBase, status: z.literal("absent"), reason: z.string() }),
  z.object({ ...laneBase, status: z.literal("failed"), reason: z.string() }),
]);
export type LensLane = z.infer<typeof LensLaneSchema>;

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

/**
 * One folded round-progress event. The server emits these from REAL round progress —
 * never a clock — and the client's `advance` walks the phases off them. `failed` is the
 * terminal arm: a crashed worker or a broken regeneration emits it, so a stalled round
 * surfaces as a failure rather than silence.
 */
export const RoundEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("operation"),
    snapshot: RoundOperationProgressSnapshotSchema,
    seq,
  }),
  z.object({ type: z.literal("dispatched"), seq }),
  z.object({ type: z.literal("prep"), rows: z.array(LaneRowSchema), seq }),
  z.object({ type: z.literal("worker"), rows: z.array(LaneRowSchema), seq }),
  z.object({ type: z.literal("gate"), seq }),
  z.object({ type: z.literal("committed"), seq }),
  z.object({ type: z.literal("report"), reportBoardId: id, seq }),
  z.object({ type: z.literal("lens"), lanes: z.array(LensLaneSchema), seq }),
  z.object({ type: z.literal("composed"), generation: id, seq }),
  /** The worker completed but its checkpoint was empty, so no generation was regenerated. */
  z.object({ type: z.literal("unchanged"), seq }),
  z.object({ type: z.literal("failed"), reason: z.string(), seq }),
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
export const SessionModelSchema = z.object({
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
  claim: ClaimSchema.optional(),
  reviewId: id.optional(),
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
});
export type SessionModel = z.infer<typeof SessionModelSchema>;
