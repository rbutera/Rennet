/**
 * Cross-harness adjudication (issue #41) — the pass that finally consumes the Model
 * Council's `adjudication` seat. Dual-harness review (#41 core) already generates
 * findings on two independent seats and `reconcileFindings` folds them into concur
 * and disagree rows by pure anchor arithmetic. But when the seats DISAGREE, Rennet
 * only ever showed the two verbatim answers side by side — nobody asked the code who
 * is right. This pass does: for each CONTESTED row (a `disagree` agreement — a solo,
 * or a severity conflict) it runs ONE fresh turn on the adjudication seat, hands it
 * both labelled answers with explicit polarity plus the REAL code window, and stamps
 * an informational verdict.
 *
 * It mirrors `finding-verification.ts` deliberately (deterministic selection + pure
 * orchestration in core; the model turn and file read INJECTED), but with ONE rule
 * that is the opposite of verification's and load-bearing under Rule Zero:
 *
 *   ⛔ ADJUDICATION NEVER DROPS A ROW. Verification's `refuted → drop` is exactly
 *      wrong for a contested row — dropping it hides the flare the dual machinery
 *      exists to surface. So the verdict vocabulary is DISTINCT (`supported`,
 *      `contradicted`, `insufficient` — never reproduced/refuted), the field is
 *      additive-optional on the disagree arm, and EVERY row that entered comes back:
 *      a `contradicted` row still renders as a disagreement with both verbatim
 *      answers, now carrying the third opinion beside them.
 *
 * Every honest-uncertainty path lands on `insufficient` WITH its reason, never an
 * omission and never a fabricated verdict: a thrown/failed/guarded turn, the
 * per-review cap, an exhausted budget, and an unreadable window all stamp
 * `insufficient`. Cost is bounded two ways on the SHARED invocation budget: only
 * disagree rows, and a per-review `DEFAULT_MAX_ADJUDICATIONS` cap (adjudicate the
 * top-K by severity; the rest surface with the cap named). No rendering waits on the
 * verdict; nothing gates on it.
 */

import {
  type AdjudicationContract,
  FINDING_ADJUDICATION_CONTRACT,
  renderFindingAdjudicationPrompt,
} from "@rennet/instructions";
import { parseAnchor, resolveAnchor } from "@rennet/protocol";
import type {
  BudgetGrant,
  FindingAdjudication,
  FindingAdjudicationVerdict,
  FindingElement,
  FindingSeverity,
  FlaggedReview,
  InvocationBudget,
  ManifestOccurrence,
  OfferedManifest,
  RspTokenUsage,
} from "@rennet/types";
import type { VerificationFileReader, VerificationFileWindow } from "./finding-verification";
import { absentBudgetGrant } from "./invocation-budget";

/** The default per-review adjudication cap: contested rows are rare, this is the ceiling on turns. */
export const DEFAULT_MAX_ADJUDICATIONS = 4;

/** One adjudication turn's result (a fresh session emits `{ adjudications }`). */
export type AdjudicationTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** Injected (adapters): run ONE fresh adjudication turn against the assembled prompt. */
export type AdjudicationTurn = (prompt: string) => Promise<AdjudicationTurnResult>;

export interface RunFindingAdjudicationInput {
  /** The reconciled findings — contested (`disagree`) rows are the adjudication candidates. */
  readonly findings: readonly FindingElement[];
  /** The offered manifest, to render each contested row's own hunk into the prompt. */
  readonly manifest: OfferedManifest;
  /** The real-file reader (adapters); resolves an anchor to the window around it. Reused from #179. */
  readonly readFileWindow: VerificationFileReader;
  /** The fresh-session adjudication turn (adapters), resolved on the council's `adjudication` seat. */
  readonly runTurn: AdjudicationTurn;
  /** The resolved seat's honest label (model + harness), stamped as `adjudicatedBy` so provenance cannot lie. */
  readonly adjudicatedBy: string;
  /** The shared live invocation budget; an absent budget runs UNGATED (no ceiling, not no spend). */
  readonly budget?: InvocationBudget;
  readonly contract?: AdjudicationContract;
  /** Max contested rows adjudicated per review; the rest surface capped. Default {@link DEFAULT_MAX_ADJUDICATIONS}. */
  readonly maxAdjudications?: number;
}

/** The cost + disposition accounting for one review's adjudication pass. */
export interface AdjudicationTelemetry {
  /** Contested (`disagree`) rows — the adjudication candidates. */
  readonly contested: number;
  /** Rows a real adjudication turn returned a verdict for (supported+contradicted+turn-insufficient). */
  readonly adjudicated: number;
  /** Model turns spent (one per contested row within the cap and budget). */
  readonly adjudicationTurns: number;
  readonly supported: number;
  readonly contradicted: number;
  /** Rows surfaced as insufficient (genuine unknown + capped + budget-refused + unreadable + turn-failed). */
  readonly insufficient: number;
  /** Contested rows stamped insufficient because the per-review cap was reached. */
  readonly cappedFindingIds: readonly string[];
  /** Contested rows stamped insufficient because the shared budget refused their turn. */
  readonly budgetRefusedFindingIds: readonly string[];
  /** Tokens spent across adjudication turns; null when no turn carried usage. */
  readonly tokensSpent: RspTokenUsage | null;
}

export interface RunFindingAdjudicationResult {
  /** All input findings in the SAME order — contested rows stamped, NOTHING dropped. */
  readonly findings: FindingElement[];
  readonly telemetry: AdjudicationTelemetry;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

const CAP_CAVEAT = (max: number): string =>
  `Could not adjudicate: the review's adjudication cap of ${max} was reached — weigh both answers yourself.`;
const BUDGET_CAVEAT =
  "Could not adjudicate: the adjudication budget was exhausted — weigh both answers yourself.";
const UNREADABLE_CAVEAT =
  "Could not adjudicate: the file content around this location was unavailable.";
const NO_VERDICT_CAVEAT =
  "Could not adjudicate: the adjudicator returned no usable verdict for this row.";
const turnFailedCaveat = (why: string): string => `Could not adjudicate: ${why}`;

interface ParsedAdjudication {
  readonly verdict: FindingAdjudicationVerdict;
  readonly evidence: string;
}

/**
 * Run the adjudication pass over a review's findings. Pure orchestration: select
 * disagree rows → rank by severity → cap → resolve real windows → one budget-gated
 * turn per row → stamp the verdict (or an honest insufficient) BACK onto the disagree
 * arm. Never throws on a turn/read failure, and NEVER drops a row — a dead adjudicator
 * leaves every contested row present, now marked "could not adjudicate".
 */
export async function runFindingAdjudication(
  input: RunFindingAdjudicationInput,
): Promise<RunFindingAdjudicationResult> {
  const contract = input.contract ?? FINDING_ADJUDICATION_CONTRACT;
  const maxAdjudications = normalizeCap(input.maxAdjudications);
  const adjudications = new Map<string, FindingAdjudication>();

  let supported = 0;
  let contradicted = 0;
  let insufficient = 0;
  let adjudicated = 0;
  let adjudicationTurns = 0;
  const cappedFindingIds: string[] = [];
  const budgetRefusedFindingIds: string[] = [];
  let tokensSpent: RspTokenUsage | null = null;

  const stamp = (
    findingId: string,
    verdict: FindingAdjudicationVerdict,
    evidence: string,
  ): void => {
    adjudications.set(findingId, { verdict, evidence, adjudicatedBy: input.adjudicatedBy });
    if (verdict === "supported") supported += 1;
    else if (verdict === "contradicted") contradicted += 1;
    else insufficient += 1;
  };

  // 1. The candidates are exactly the contested (disagree) rows — divergence is the
  //    trigger, severity is irrelevant to eligibility (a low-severity solo is still a
  //    disagreement worth one cheap look). Concur rows spend nothing.
  const candidates = input.findings.filter((f) => f.agreement.kind === "disagree");

  // 2. Rank (high → medium → low, then findingId) and apply the cap. The over-cap
  //    remainder is stamped an honest capped-insufficient — never a silent skip.
  const ranked = [...candidates].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareIds(a.findingId, b.findingId),
  );
  for (const finding of ranked.slice(maxAdjudications)) {
    stamp(finding.findingId, "insufficient", CAP_CAVEAT(maxAdjudications));
    cappedFindingIds.push(finding.findingId);
  }

  // 3. One budget-gated adjudication turn per contested row within the cap.
  for (const finding of ranked.slice(0, maxAdjudications)) {
    const window = await readWindowSafely(input.readFileWindow, finding.anchor);
    if (window === undefined) {
      stamp(finding.findingId, "insufficient", UNREADABLE_CAVEAT);
      continue;
    }

    const purpose = `finding-adjudication:${finding.findingId}`;
    const grant: BudgetGrant = input.budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      stamp(finding.findingId, "insufficient", BUDGET_CAVEAT);
      budgetRefusedFindingIds.push(finding.findingId);
      continue;
    }

    const answers =
      finding.agreement.kind === "disagree" ? finding.agreement.answers : [];
    const prompt = renderFindingAdjudicationPrompt(contract, {
      file: window,
      row: {
        ref: "a1",
        severity: finding.severity,
        anchor: finding.anchor,
        answers,
        hunk: hunkTextForAnchor(finding.anchor, input.manifest),
      },
    });

    const turn = await runTurnSafely(input.runTurn, prompt);
    adjudicationTurns += 1;
    adjudicated += 1;

    if (turn.status === "failed") {
      stamp(finding.findingId, "insufficient", turnFailedCaveat(turn.message));
      continue;
    }
    if (turn.tokens) tokensSpent = addTokens(tokensSpent, turn.tokens);

    const parsed = parseSingleAdjudication(turn.body);
    if (!parsed) {
      stamp(finding.findingId, "insufficient", NO_VERDICT_CAVEAT);
      continue;
    }
    const evidence =
      parsed.evidence.trim().length > 0 ? parsed.evidence.trim() : NO_VERDICT_CAVEAT;
    stamp(finding.findingId, parsed.verdict, evidence);
  }

  // 4. Reassemble in ORIGINAL order. NOTHING is dropped: a contested row gets its
  //    verdict stamped onto the disagree arm; every other row passes through as-is.
  const findings: FindingElement[] = input.findings.map((finding) => {
    const adjudication = adjudications.get(finding.findingId);
    if (adjudication === undefined || finding.agreement.kind !== "disagree") return finding;
    return { ...finding, agreement: { ...finding.agreement, adjudication } };
  });

  return {
    findings,
    telemetry: {
      contested: candidates.length,
      adjudicated,
      adjudicationTurns,
      supported,
      contradicted,
      insufficient,
      cappedFindingIds,
      budgetRefusedFindingIds,
      tokensSpent,
    },
  };
}

/**
 * The additive composition point (issue #41): adjudicate a whole `FlaggedReview`.
 * Mirrors `verifyFlaggedReview` — a command that produced the reconciled findings hands
 * the review here (typically AFTER verification) and gets back the SAME review with
 * every contested row's disagree arm stamped with the third-opinion verdict, plus the
 * cost telemetry. A `failed` review passes through untouched. Purely additive: a caller
 * that does not invoke it sees today's behaviour.
 */
export async function adjudicateFlaggedReview(
  review: FlaggedReview,
  options: Omit<RunFindingAdjudicationInput, "findings">,
): Promise<{ review: FlaggedReview; telemetry: AdjudicationTelemetry }> {
  if (review.status !== "ok") return { review, telemetry: emptyAdjudicationTelemetry() };
  const result = await runFindingAdjudication({ ...options, findings: review.findings });
  return {
    review: {
      status: "ok",
      findings: result.findings,
      ...(review.dual ? { dual: review.dual } : {}),
    },
    telemetry: result.telemetry,
  };
}

/** The empty telemetry for a review that ran no adjudication (failed, or all-concur). */
export function emptyAdjudicationTelemetry(): AdjudicationTelemetry {
  return {
    contested: 0,
    adjudicated: 0,
    adjudicationTurns: 0,
    supported: 0,
    contradicted: 0,
    insufficient: 0,
    cappedFindingIds: [],
    budgetRefusedFindingIds: [],
    tokensSpent: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize the cap, fail-closed on a bad value: non-finite/negative → 0 (every row capped-insufficient). */
function normalizeCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ADJUDICATIONS;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

async function readWindowSafely(
  read: VerificationFileReader,
  anchor: string,
): Promise<VerificationFileWindow | undefined> {
  try {
    return await read(anchor);
  } catch {
    return undefined;
  }
}

/** Run the injected turn, coercing a thrown turn to an honest failure (never a crash, never a drop). */
async function runTurnSafely(
  runTurn: AdjudicationTurn,
  prompt: string,
): Promise<AdjudicationTurnResult> {
  try {
    return await runTurn(prompt);
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Render a contested row's own offered hunk (from the manifest) into the prompt; best-effort. */
function hunkTextForAnchor(anchor: string, manifest: OfferedManifest): string {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return "";
  const resolution = resolveAnchor(parsed.anchor, manifest);
  if (resolution.outcome !== "resolved") return "";
  const occurrence = manifest.occurrences.find(
    (candidate) => candidate.id === resolution.occurrenceId,
  );
  return occurrence ? renderSides(occurrence) : "";
}

function renderSides(occurrence: ManifestOccurrence): string {
  const sides = occurrence.sides ?? {};
  const parts: string[] = [];
  for (const line of sides.deletions ?? []) parts.push(`- ${line}`);
  for (const line of sides.additions ?? []) parts.push(`+ ${line}`);
  for (const line of sides.context ?? []) parts.push(`  ${line}`);
  return parts.join("\n");
}

/** Parse the single verdict from a one-row adjudication turn's emitted body, defensively. */
function parseSingleAdjudication(body: unknown): ParsedAdjudication | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const list = (body as { adjudications?: unknown }).adjudications;
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const verdict = record.verdict;
    if (verdict !== "supported" && verdict !== "contradicted" && verdict !== "insufficient")
      continue;
    return { verdict, evidence: typeof record.evidence === "string" ? record.evidence : "" };
  }
  return undefined;
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function addTokens(acc: RspTokenUsage | null, next: RspTokenUsage): RspTokenUsage {
  if (!acc) return next;
  return {
    input: acc.input + next.input,
    output: acc.output + next.output,
    cacheRead: acc.cacheRead + next.cacheRead,
    cacheWrite: acc.cacheWrite + next.cacheWrite,
    reasoning: sumNullable(acc.reasoning, next.reasoning),
    total: acc.total + next.total,
  };
}
