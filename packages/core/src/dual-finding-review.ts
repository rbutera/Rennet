/**
 * runDualFindingReview — the dual-model Flagged lens orchestration (issue #41).
 *
 * The Flagged lens's finding runner (`runFindingAngle`, #32) turns a change's
 * offered hunks into grounded findings on ONE model seat. This wraps it into the
 * dual-model shape Rai's #41 invariant asks for:
 *
 *   • DEEP review + two provider seats → run the SAME runner INDEPENDENTLY on each
 *     seat (Claude, Codex), each fed the SAME hypothesis disconfirmers and manifest,
 *     then reconcile the two grounded sets into agreement/disagreement. Neither seat
 *     sees the other's output; disagreement is surfaced, NEVER averaged.
 *   • QUICK review (deepReview:false) → the single Claude seat, byte-identical to
 *     today. Hypothesis-first is always on; dual-model is the deep-review feature.
 *   • GRACEFUL DEGRADATION — if the second seat is unavailable or errors (Codex can
 *     flake), the review degrades to the single seat's own findings (each keeps its
 *     honest `concur 1/1`) with an explicit "second seat unavailable" marker. Never
 *     a fabricated concurrence, never a hang: each seat is guarded and budget-bounded.
 *
 * Each seat runs as its OWN budget-gated action (`makeBudget()` per seat), mirroring
 * how the production commands treat each producer — so one seat's retries can never
 * starve the other, and the total is bounded by (seats × ceiling).
 */

import type { AssembleOptions, PromptContract } from "@rennet/instructions";
import type {
  ContextSendRecord,
  ConventionCatalogue,
  CouncilHarnessId,
  DualReviewNote,
  FlaggedReview,
  InvocationBudget,
  OfferedManifest,
  ReviewHypothesis,
} from "@rennet/types";
import type { DualSeat } from "./dual-seat";
import {
  type FindingIntent,
  type RunFindingAngleResult,
  runFindingAngle,
} from "./finding-generation";
import { reconcileFindings } from "./finding-reconcile";
import { guardSeatTurn, recordSeatSend } from "./harness-run-turn";

export interface RunDualFindingReviewInput {
  /**
   * Opt into the dual-model path. False (or fewer than two seats) runs the single
   * Claude seat — today's quick review, unchanged.
   */
  readonly deepReview: boolean;
  readonly patchsetId: string;
  readonly manifest: OfferedManifest;
  /** The ordered seats from `resolveDualSeat` (Claude first, Codex second). */
  readonly seats: readonly DualSeat[];
  /** The change's stated intent (#136), fed to BOTH seats' `task` slot. */
  readonly intent?: FindingIntent;
  /** The committed hypothesis (#178), fed to BOTH seats as disconfirmation criteria. */
  readonly hypothesis?: ReviewHypothesis;
  /** The per-project convention catalogue (#180), fed to BOTH seats as a checklist layer. */
  readonly conventions?: ConventionCatalogue;
  readonly contract?: PromptContract;
  /** Builds one fresh invocation budget per seat run (each seat its own ceiling). */
  readonly makeBudget: () => InvocationBudget;
  readonly guidance?: { readonly general?: string; readonly files?: string };
  readonly assembledContext?: string;
  readonly onSend?: (record: ContextSendRecord) => void;
  readonly assembleOptions?: AssembleOptions;
  readonly maxRetries?: number;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

/** One seat's run, retained for cost/telemetry (the document carries token usage). */
export interface DualSeatRun {
  readonly label: string;
  readonly provider: CouncilHarnessId;
  readonly result: RunFindingAngleResult;
}

export interface RunDualFindingReviewResult {
  /** The lens's typed input — the reconciled findings, or the loud failed state. */
  readonly review: FlaggedReview;
  /** Per-seat results (for the cost table / provenance); empty when no seat ran. */
  readonly seatRuns: DualSeatRun[];
}

/** Run one seat's finding attempt, guarded and on its own fresh budget. */
async function runSeat(seat: DualSeat, input: RunDualFindingReviewInput): Promise<DualSeatRun> {
  const result = await runFindingAngle({
    patchsetId: input.patchsetId,
    manifest: input.manifest,
    provenance: seat.seed,
    // A thrown turn (a Codex spawn or session/transport exception) degrades to a
    // turn-failure rather than crashing the review (#96) — the seat then fails and
    // the reconcile degrades to the other seat.
    runTurn: guardSeatTurn(
      input.onSend
        ? recordSeatSend(seat.runTurn, { seat: "finding", harness: seat.provider }, input.onSend)
        : seat.runTurn,
    ),
    budget: input.makeBudget(),
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.hypothesis ? { hypothesis: input.hypothesis } : {}),
    ...(input.conventions ? { conventions: input.conventions } : {}),
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.guidance ? { guidance: input.guidance } : {}),
    ...(input.assembledContext === undefined ? {} : { assembledContext: input.assembledContext }),
    ...(input.assembleOptions ? { assembleOptions: input.assembleOptions } : {}),
    ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
    ...(input.mintDocId ? { mintDocId: input.mintDocId } : {}),
    ...(input.newRunId ? { newRunId: input.newRunId } : {}),
  });
  return { label: seat.label, provider: seat.provider, result };
}

/** The single-seat outcome mapped to a `FlaggedReview` (optionally noting degradation). */
function singleSeatReview(run: DualSeatRun, note?: DualReviewNote): FlaggedReview {
  if (run.result.status === "ok") {
    return { status: "ok", findings: run.result.findings, ...(note ? { dual: note } : {}) };
  }
  return {
    status: "failed",
    reason: run.result.failureReason ?? "the finding runner did not complete",
  };
}

export async function runDualFindingReview(
  input: RunDualFindingReviewInput,
): Promise<RunDualFindingReviewResult> {
  const seats = input.seats;
  if (seats.length === 0) {
    return {
      review: { status: "failed", reason: "no model seat is available to run the review" },
      seatRuns: [],
    };
  }

  const seatA = seats[0] as DualSeat;
  const wantDual = input.deepReview && seats.length >= 2;

  // ── Quick review, or deep review with only one provider installed ──────────
  if (!wantDual) {
    const run = await runSeat(seatA, input);
    // A deep review that could only find one provider says so honestly; a quick
    // review carries no dual note at all (byte-identical to the pre-#41 shape).
    const note: DualReviewNote | undefined =
      input.deepReview && run.result.status === "ok"
        ? {
            seats: [seatA.label],
            secondSeatUnavailable: "only one provider is installed — no second opinion",
          }
        : undefined;
    return { review: singleSeatReview(run, note), seatRuns: [run] };
  }

  // ── Dual review: two seats, run independently, reconciled ──────────────────
  const seatB = seats[1] as DualSeat;
  const runA = await runSeat(seatA, input);
  const runB = await runSeat(seatB, input);
  const seatRuns: DualSeatRun[] = [runA, runB];

  const aOk = runA.result.status === "ok";
  const bOk = runB.result.status === "ok";

  if (aOk && bOk) {
    const findings = reconcileFindings(runA.result.findings, runB.result.findings, {
      a: seatA.label,
      b: seatB.label,
    });
    return {
      review: { status: "ok", findings, dual: { seats: [seatA.label, seatB.label] } },
      seatRuns,
    };
  }

  // One seat failed → degrade to the surviving seat's own findings (each still
  // carries its honest `concur 1/1`), with an explicit marker. NEVER a fabricated
  // concurrence; the reviewer sees one provider's opinion and is told why.
  if (aOk && !bOk) {
    return {
      review: {
        status: "ok",
        findings: runA.result.findings,
        dual: {
          seats: [seatA.label],
          secondSeatUnavailable: `${seatB.label} produced no findings (${
            runB.result.failureReason ?? "the seat did not complete"
          })`,
        },
      },
      seatRuns,
    };
  }
  if (!aOk && bOk) {
    return {
      review: {
        status: "ok",
        findings: runB.result.findings,
        dual: {
          seats: [seatB.label],
          secondSeatUnavailable: `${seatA.label} produced no findings (${
            runA.result.failureReason ?? "the seat did not complete"
          })`,
        },
      },
      seatRuns,
    };
  }

  // Both seats failed → the loud failed state (never faked from "did not run").
  return {
    review: {
      status: "failed",
      reason: runA.result.failureReason ?? "the finding runner did not complete",
    },
    seatRuns,
  };
}
