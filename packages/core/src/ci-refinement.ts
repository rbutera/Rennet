import {
  CI_CLASSIFICATION_CONTRACT,
  type CiClassificationContract,
  type PromptContextFile,
  renderCiClassificationPrompt,
} from "@rennet/prompts";
import type { CiFailure, InvocationBudget, RspTokenUsage } from "@rennet/protocol";
import type { TurnContextWriter } from "./harness-run-turn";
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
  /**
   * The session-context writer (the daemon). The failures, their evidence blobs and the
   * changed-path list are written through it and NAMED by the prompt; none of them is
   * interpolated (session-context-files, D4).
   */
  readonly writeContext: TurnContextWriter;
  readonly budget?: InvocationBudget;
  readonly contract?: CiClassificationContract;
  readonly signal?: AbortSignal;
}

/** The pointer file, at the context directory's root so its entries resolve beside it. */
const CI_POINTERS = "ci-pointers.json";

/**
 * The turn's context files: one evidence blob per unclassified failure, the changed-path
 * list, and the pointer file that names them. Every path inside the pointer file is
 * relative to the directory the pointer file itself sits in — the same frame the
 * directory's `README.md` index uses — so one write suffices. Returns the pointer file's
 * path relative to the turn's cwd, for the prompt to name.
 */
function writeCiContext(
  write: TurnContextWriter,
  candidates: readonly Candidate[],
  changedPaths: readonly string[],
): string {
  const evidenceName = (ref: string) => `ci-classification/evidence/${ref}.txt`;
  const changedPathsName = "ci-classification/changed-paths.txt";
  const files: PromptContextFile[] = candidates.map(({ ref, failure }) => ({
    name: evidenceName(ref),
    body: failure.evidence,
    holds: `The failure evidence CI reported for the "${failure.checkName}" check.`,
    readWhen: `before you classify ${ref}.`,
  }));
  files.push(
    {
      name: changedPathsName,
      body: `${changedPaths.join("\n")}\n`,
      holds: "Every path this change touches, one per line.",
      readWhen: "when you are deciding whether a failure is attributable to this change.",
    },
    {
      name: CI_POINTERS,
      // Compact: an indent is a ~30% surcharge no reader sees (#737).
      body: JSON.stringify({
        turn: "ci-failure-classification",
        pathsRelativeTo: "this file's directory",
        changedPaths: changedPathsName,
        failures: candidates.map(({ ref, failure }) => ({
          ref,
          checkName: failure.checkName,
          evidence: evidenceName(ref),
        })),
      }),
      holds: "Every unclassified failure — its ref, its check name, and where its evidence is.",
      readWhen: "first, before you classify anything.",
    },
  );
  return `${write(files)}/${CI_POINTERS}`;
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
    pointersPath: writeCiContext(input.writeContext, candidates, input.changedPaths),
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
