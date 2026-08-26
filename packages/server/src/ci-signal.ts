import {
  type CiRefinementTurn,
  ciFindingIdFor,
  ciFindingsFor,
  classifyCiFailures,
  type ForgeCiStatus,
  type ForgePullRequestRef,
  refineCiFailures,
} from "@rennet/core";
import type {
  CiSignal,
  FlaggedReview,
  InvocationBudget,
  OfferedManifest,
  Patchset,
  ReviewPostTarget,
} from "@rennet/protocol";

export interface AttachCiSignalInput {
  readonly review: FlaggedReview;
  readonly postTarget?: ReviewPostTarget;
  readonly patchset: Patchset;
  readonly manifest: OfferedManifest;
  readonly fetchCiStatus: (
    ref: ForgePullRequestRef,
    headOid: string,
    signal?: AbortSignal,
  ) => Promise<ForgeCiStatus>;
  readonly refineTurn?: CiRefinementTurn;
  readonly budget?: InvocationBudget;
  readonly fetchTimeoutMs?: number;
  readonly refinementTimeoutMs?: number;
}

export const CI_FETCH_TIMEOUT_MS = 15_000;
export const CI_REFINEMENT_TIMEOUT_MS = 30_000;

function overallOf(status: ForgeCiStatus): "passing" | "failing" | "pending" {
  if (status.checks.some((check) => check.outcome === "failing")) return "failing";
  if (status.incomplete || status.checks.some((check) => check.outcome === "pending")) {
    return "pending";
  }
  if (status.checks.some((check) => check.outcome === "passing")) return "passing";
  return "pending";
}

async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unavailableReason(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  return detail.length > 0 ? detail : "the forge did not return CI status";
}

export async function attachCiSignal(input: AttachCiSignalInput): Promise<FlaggedReview> {
  if (input.postTarget === undefined) return input.review;
  const target = input.postTarget;
  try {
    const fetched = await withDeadline(
      (signal) =>
        input.fetchCiStatus({ repo: target.repo, number: target.number }, target.headOid, signal),
      input.fetchTimeoutMs ?? CI_FETCH_TIMEOUT_MS,
      "CI status fetch",
    );
    if (fetched.checks.length === 0 && !fetched.incomplete) {
      return { ...input.review, ciSignal: { status: "no-checks", headOid: target.headOid } };
    }

    const changedPaths = input.patchset.files.map((file) => file.path);
    let failures = classifyCiFailures(fetched.checks, changedPaths);
    const refineTurn = input.refineTurn;
    if (
      refineTurn !== undefined &&
      failures.some((failure) => failure.verdict === "unclassified")
    ) {
      try {
        const refined = await withDeadline(
          (signal) =>
            refineCiFailures({
              failures,
              changedPaths,
              runTurn: refineTurn,
              signal,
              ...(input.budget === undefined ? {} : { budget: input.budget }),
            }),
          input.refinementTimeoutMs ?? CI_REFINEMENT_TIMEOUT_MS,
          "CI classification refinement",
        );
        failures = refined.failures;
      } catch {
        // Refinement is optional: keep the deterministic verdicts on timeout or failure.
      }
    }
    const ciFindings =
      input.review.status === "failed"
        ? []
        : ciFindingsFor(failures, input.manifest, input.patchset.id);
    const placedFindingIds = new Set(ciFindings.map((finding) => finding.findingId));
    const surfacedFailures = failures.map((failure) => {
      const findingId = ciFindingIdFor(failure, input.patchset.id);
      return placedFindingIds.has(findingId) ? { ...failure, findingId } : failure;
    });
    const ciSignal: CiSignal = {
      status: "checked",
      overall: overallOf(fetched),
      failures: surfacedFailures,
      headOid: target.headOid,
      incomplete: fetched.incomplete,
    };
    if (input.review.status === "failed") return { ...input.review, ciSignal };
    return {
      ...input.review,
      findings: [...input.review.findings, ...ciFindings],
      ciSignal,
    };
  } catch (error) {
    return {
      ...input.review,
      ciSignal: { status: "unavailable", reason: unavailableReason(error) },
    };
  }
}
