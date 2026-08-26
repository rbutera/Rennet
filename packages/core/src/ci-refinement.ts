import {
  CI_CLASSIFICATION_CONTRACT,
  type CiClassificationContract,
  renderCiClassificationPrompt,
} from "@rennet/instructions";
import type { CiFailure, InvocationBudget, RspTokenUsage } from "@rennet/protocol";
import { absentBudgetGrant } from "./invocation-budget";

export type CiRefinementTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

export type CiRefinementTurn = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<CiRefinementTurnResult>;

export interface CiRefinementTelemetry {
  readonly candidates: number;
  readonly turns: number;
  readonly refined: number;
  readonly budgetRefused: boolean;
  readonly tokensSpent: RspTokenUsage | null;
  readonly failureReason?: string;
}

export interface RefineCiFailuresInput {
  readonly failures: readonly CiFailure[];
  readonly changedPaths: readonly string[];
  readonly runTurn: CiRefinementTurn;
  readonly budget?: InvocationBudget;
  readonly contract?: CiClassificationContract;
  readonly signal?: AbortSignal;
}

interface Candidate {
  readonly ref: string;
  readonly index: number;
  readonly failure: CiFailure;
}

type ModelVerdict = CiFailure["verdict"];

function parseClassifications(
  body: unknown,
  candidates: readonly Candidate[],
): Map<string, ModelVerdict> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.classifications)) return null;
  if (record.classifications.length !== candidates.length) return null;
  const expected = new Set(candidates.map((candidate) => candidate.ref));
  const parsed = new Map<string, ModelVerdict>();
  for (const raw of record.classifications) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "ref,verdict") return null;
    if (typeof item.ref !== "string" || !expected.has(item.ref) || parsed.has(item.ref))
      return null;
    if (
      item.verdict !== "change-caused" &&
      item.verdict !== "environmental" &&
      item.verdict !== "unclassified"
    ) {
      return null;
    }
    parsed.set(item.ref, item.verdict);
  }
  return parsed.size === candidates.length ? parsed : null;
}

function unchanged(
  failures: readonly CiFailure[],
  telemetry: CiRefinementTelemetry,
): { failures: CiFailure[]; telemetry: CiRefinementTelemetry } {
  return { failures: [...failures], telemetry };
}

export async function refineCiFailures(
  input: RefineCiFailuresInput,
): Promise<{ failures: CiFailure[]; telemetry: CiRefinementTelemetry }> {
  const candidates: Candidate[] = [];
  input.failures.forEach((failure, index) => {
    if (failure.verdict === "unclassified") {
      candidates.push({ ref: `failure-${index}`, index, failure });
    }
  });
  const baseTelemetry = {
    candidates: candidates.length,
    turns: 0,
    refined: 0,
    budgetRefused: false,
    tokensSpent: null,
  } as const;
  if (candidates.length === 0) return unchanged(input.failures, baseTelemetry);

  const grant =
    input.budget?.tryConsume("ci-failure-classification") ??
    absentBudgetGrant("ci-failure-classification");
  if (!grant.granted) {
    return unchanged(input.failures, {
      ...baseTelemetry,
      budgetRefused: true,
      failureReason: grant.reason,
    });
  }

  const prompt = renderCiClassificationPrompt(input.contract ?? CI_CLASSIFICATION_CONTRACT, {
    failures: candidates.map(({ ref, failure }) => ({
      ref,
      checkName: failure.checkName,
      evidence: failure.evidence,
    })),
    changedPaths: input.changedPaths,
  });
  let turn: CiRefinementTurnResult;
  try {
    turn = await input.runTurn(prompt, input.signal);
  } catch (error) {
    return unchanged(input.failures, {
      ...baseTelemetry,
      turns: 1,
      failureReason: error instanceof Error ? error.message : String(error),
    });
  }
  if (turn.status === "failed") {
    return unchanged(input.failures, {
      ...baseTelemetry,
      turns: 1,
      failureReason: turn.message,
    });
  }
  const classifications = parseClassifications(turn.body, candidates);
  if (classifications === null) {
    return unchanged(input.failures, {
      ...baseTelemetry,
      turns: 1,
      tokensSpent: turn.tokens ?? null,
      failureReason: "invalid CI classification response; deterministic verdicts retained",
    });
  }

  const failures = [...input.failures];
  let refined = 0;
  for (const candidate of candidates) {
    const verdict = classifications.get(candidate.ref);
    if (verdict !== "change-caused") continue;
    failures[candidate.index] = {
      ...candidate.failure,
      verdict,
      classifiedBy: "model",
    };
    refined += 1;
  }
  return {
    failures,
    telemetry: {
      ...baseTelemetry,
      turns: 1,
      refined,
      tokensSpent: turn.tokens ?? null,
    },
  };
}
