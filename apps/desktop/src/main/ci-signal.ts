import {
  type CiRefinementTurn,
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
} from "@rennet/types";

export interface AttachCiSignalInput {
  readonly review: FlaggedReview;
  readonly postTarget?: ReviewPostTarget;
  readonly patchset: Patchset;
  readonly manifest: OfferedManifest;
  readonly fetchCiStatus: (ref: ForgePullRequestRef, headOid: string) => Promise<ForgeCiStatus>;
  readonly refineTurn?: CiRefinementTurn;
  readonly budget?: InvocationBudget;
}

function overallOf(checks: ForgeCiStatus["checks"]): "passing" | "failing" | "pending" {
  if (checks.some((check) => check.outcome === "failing")) return "failing";
  if (checks.some((check) => check.outcome === "pending")) return "pending";
  return "passing";
}

function unavailableReason(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  return detail.length > 0 ? detail : "the forge did not return CI status";
}

export async function attachCiSignal(input: AttachCiSignalInput): Promise<FlaggedReview> {
  if (input.postTarget === undefined) return input.review;
  const target = input.postTarget;
  try {
    const fetched = await input.fetchCiStatus(
      { repo: target.repo, number: target.number },
      target.headOid,
    );
    if (fetched.checks.length === 0 && fetched.sso.kind !== "partial-results") {
      return { ...input.review, ciSignal: { status: "no-checks", headOid: target.headOid } };
    }

    const changedPaths = input.patchset.files.map((file) => file.path);
    let failures = classifyCiFailures(fetched.checks, changedPaths);
    if (
      input.refineTurn !== undefined &&
      failures.some((failure) => failure.verdict === "unclassified")
    ) {
      const refined = await refineCiFailures({
        failures,
        changedPaths,
        runTurn: input.refineTurn,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
      });
      failures = refined.failures;
    }
    const ciSignal: CiSignal = {
      status: "checked",
      overall: overallOf(fetched.checks),
      failures,
      headOid: target.headOid,
      incomplete: fetched.sso.kind === "partial-results",
    };
    if (input.review.status === "failed") return { ...input.review, ciSignal };
    return {
      ...input.review,
      findings: [
        ...input.review.findings,
        ...ciFindingsFor(failures, input.manifest, input.patchset.id),
      ],
      ciSignal,
    };
  } catch (error) {
    return {
      ...input.review,
      ciSignal: { status: "unavailable", reason: unavailableReason(error) },
    };
  }
}
