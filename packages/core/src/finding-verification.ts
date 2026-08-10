/**
 * Per-finding reproduce-or-refute verification (issue #179) — the third and last
 * piece of the Review Intelligence Core's "ballgame" (with hypothesis-first #178
 * and dual-model #41). It turns "a model claims X" into "we reproduced X against
 * the real code," so a beautiful reading surface over a single unverified model is
 * not a prettier rubber stamp.
 *
 * Two pure, node-free pieces live here (the deterministic gate + the pure
 * orchestration); the model I/O and the real-file read are INJECTED, so this module
 * stays testable with a mock and preserves the dependency arrows the design fixes
 * (deterministic gate + pure logic in `core`; model + store I/O in `adapters`).
 *
 *   ① classifyNonObvious — a deterministic, versioned gate: which findings pay for
 *      a verification turn (a high/medium BEHAVIOURAL/CORRECTNESS claim that needs
 *      reasoning beyond its hunk), and which are obvious (a low nit, or a mechanical
 *      claim the floor already settles) and surface directly with no chip.
 *   ② runFindingVerification — for each non-obvious finding, a FRESH verification
 *      pass fed the REAL file content around its anchor (more than the offered hunk),
 *      instructed to reproduce, refute, or return inconclusive.
 *
 * The DISPOSITION is load-bearing and asymmetric (Rai + Rule 75/81ak, could-not-check
 * beats a false clear):
 *   • refuted     → DROPPED, never surfaces (the anti-hallucination-of-substance gate).
 *   • reproduced  → surfaces WITH its evidence chip ("we dug into it and found Y").
 *   • inconclusive→ surfaces WITH an honest "could not verify" caveat, NEVER dropped —
 *                   because for a claim of a PROBLEM, a silent drop of an unverifiable
 *                   claim fails toward hiding a real bug, the exact rubber-stamp this
 *                   fights. Uncertainty, the per-review cap, an exhausted budget, and
 *                   unreadable code all land here (never as a drop, never as a clear).
 *
 * Cost is bounded three ways, all consuming the shared invocation budget: only
 * non-obvious findings, a per-review `maxVerifications` cap (verify the top-K by
 * severity, the rest surface caveated), and batching (findings sharing a file are
 * one turn). Every bound is a caveat, never a silent truncation.
 */

import {
  FINDING_VERIFICATION_CONTRACT,
  renderFindingVerificationPrompt,
  type VerificationContract,
  type VerificationPromptFinding,
} from "@rennet/instructions";
import { parseAnchor, resolveAnchor } from "@rennet/protocol";
import type {
  BudgetGrant,
  FindingElement,
  FindingSeverity,
  FindingVerdict,
  FindingVerification,
  FlaggedReview,
  InvocationBudget,
  ManifestOccurrence,
  OfferedManifest,
  RspTokenUsage,
} from "@rennet/types";
import { budgetAbsentRefusal } from "./invocation-budget";

// ── ① The deterministic non-obvious gate ─────────────────────────────────────

/** Bumped when the classifier's rule set changes (A/B-able against verify quality). */
export const NON_OBVIOUS_CLASSIFIER_VERSION = 1;

/** The default per-review verification cap: verify the top-K by severity (§design). */
export const DEFAULT_MAX_VERIFICATIONS = 8;

/**
 * Summaries a medium/high finding can still be OBVIOUS on: a mechanical claim the
 * deterministic layer already settles ("this import is now unused"), which does not
 * need a model turn to confirm. Kept small, tight, and testable; the version above
 * moves when this set does.
 */
const OBVIOUS_MECHANICAL_PATTERNS: readonly RegExp[] = [
  /\bunused import\b/i,
  /\bimport is (now )?unused\b/i,
  /\bunused (variable|parameter|binding|symbol)\b/i,
  /\btypo\b/i,
  /\bformatting\b/i,
  /\bwhitespace\b/i,
  /\bindentation\b/i,
  /\breorder(ed|ing)? (of )?imports?\b/i,
];

/**
 * Decide whether a finding warrants a verification turn. Deterministic, no model
 * turn (§spec). A LOW-severity finding is a nit — surface directly, no chip. A
 * high/medium finding is non-obvious (verify) UNLESS its summary is a mechanical
 * claim the floor already settles. The bias is conservative in the safe direction:
 * a false non-obvious merely spends a turn; a false obvious would let an unverified
 * behavioural claim surface without a chip, which is the milder miss here because
 * such a claim still surfaces (it just skips the reproduce-or-refute gate).
 */
export function classifyNonObvious(finding: FindingElement): boolean {
  if (finding.severity === "low") return false;
  if (OBVIOUS_MECHANICAL_PATTERNS.some((pattern) => pattern.test(finding.summary))) return false;
  return true;
}

// ── ② The verification pass ───────────────────────────────────────────────────

/** The real file content around a finding's anchor — MORE than the offered hunk (§spec). */
export interface VerificationFileWindow {
  readonly path: string;
  /** 1-based first file line of `text`. */
  readonly startLine: number;
  /** 1-based last file line of `text`. */
  readonly endLine: number;
  /** The file's real content across `[startLine, endLine]`. */
  readonly text: string;
}

/**
 * Injected (adapters): resolve a finding's anchor to the real file window around it.
 * `undefined` when the file/window is unavailable (snapshot refused, unsafe path,
 * unreadable) — an honest inconclusive, NEVER a drop and NEVER a clear. Fed the real
 * content beyond the offered hunk so the verifier can trace the claim through the
 * actual code.
 */
export type VerificationFileReader = (
  anchor: string,
) => Promise<VerificationFileWindow | undefined>;

/** One batched verification turn's result (a fresh session emits `{ verifications }`). */
export type VerificationTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** Injected (adapters): run ONE batched verification turn against the assembled prompt. */
export type VerificationTurn = (prompt: string) => Promise<VerificationTurnResult>;

export interface RunFindingVerificationInput {
  /** The findings to verify — the reconciled Flagged set (dual-model #41) or single-seat. */
  readonly findings: readonly FindingElement[];
  /** The offered manifest, to render each finding's own hunk into the verifier's prompt. */
  readonly manifest: OfferedManifest;
  /** The real-file reader (adapters); resolves an anchor to the window around it. */
  readonly readFileWindow: VerificationFileReader;
  /** The fresh-session verification turn (adapters); by default a different seat than the raiser. */
  readonly runTurn: VerificationTurn;
  /**
   * The shared live invocation budget (Rule 75, vital money circuit). Consulted
   * before EVERY verification turn — an over-ceiling OR an ABSENT budget refuses
   * fail-closed, and the affected findings surface with a "not verified" caveat
   * (the ceiling stops spend, never the review). Optional only as a test ergonomic.
   */
  readonly budget?: InvocationBudget;
  readonly contract?: VerificationContract;
  /** Max FINDINGS verified per review; the rest surface caveated. Default {@link DEFAULT_MAX_VERIFICATIONS}. */
  readonly maxVerifications?: number;
}

/** The cost + disposition accounting for one review's verification pass. */
export interface VerificationTelemetry {
  /** Non-obvious findings (the verification candidates). */
  readonly candidates: number;
  /** Findings a real verification turn returned a verdict for (reproduced+refuted+turn-inconclusive). */
  readonly verifiedFindings: number;
  /** Model turns spent (one per file batch). The "+N turns" of the cost line. */
  readonly verificationTurns: number;
  readonly reproduced: number;
  /** Refuted findings — DROPPED, never surfaced. */
  readonly refuted: number;
  /** Findings surfaced WITH a caveat (genuine uncertainty + capped + budget-refused + unreadable). */
  readonly inconclusive: number;
  /** Findings that surfaced caveated because the per-review cap was reached. */
  readonly cappedFindingIds: readonly string[];
  /** Findings that surfaced caveated because the shared budget refused their turn. */
  readonly budgetRefusedFindingIds: readonly string[];
  /** Tokens spent across verification turns; the "+M tokens" of the cost line. Null when no turn carried usage. */
  readonly tokensSpent: RspTokenUsage | null;
}

export interface RunFindingVerificationResult {
  /**
   * The findings to surface: obvious ones unchanged, reproduced ones with a chip,
   * inconclusive ones with a caveat; REFUTED ones removed. Returned in the SAME
   * order as the input `findings` (minus drops), so downstream ordering is stable.
   */
  readonly findings: FindingElement[];
  readonly telemetry: VerificationTelemetry;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

const CAP_CAVEAT = (max: number): string =>
  `Not verified: the review's verification cap of ${max} was reached — review this flag yourself.`;
const BUDGET_CAVEAT =
  "Not verified: the verification budget was exhausted — review this flag yourself.";
const UNREADABLE_CAVEAT = "Could not verify: the file content around this flag was unavailable.";
const NO_VERDICT_CAVEAT =
  "Could not verify: the verifier returned no usable verdict for this flag.";
const turnFailedCaveat = (why: string): string => `Could not verify: ${why}`;

/** The per-finding routing decision the pass computes, applied in original order at the end. */
type Decision =
  | { readonly kind: "keep" }
  | { readonly kind: "attach"; readonly verification: FindingVerification }
  | { readonly kind: "drop" };

interface ResolvedFinding {
  readonly finding: FindingElement;
  readonly window: VerificationFileWindow;
}

interface ParsedVerdict {
  readonly verdict: FindingVerdict;
  readonly evidence: string;
}

/**
 * Run the verification pass over a review's findings. Pure orchestration: classify
 * → cap → resolve real windows → batch by file → one budget-gated turn per batch →
 * dispose (drop refuted, chip reproduced, caveat everything else). Never throws on a
 * turn/read failure — those become honest inconclusive caveats, so a dead verifier
 * can never read as an all-clear.
 */
export async function runFindingVerification(
  input: RunFindingVerificationInput,
): Promise<RunFindingVerificationResult> {
  const contract = input.contract ?? FINDING_VERIFICATION_CONTRACT;
  const maxVerifications = normalizeCap(input.maxVerifications);
  const decisions = new Map<string, Decision>();

  let reproduced = 0;
  let refuted = 0;
  let inconclusive = 0;
  let verifiedFindings = 0;
  let verificationTurns = 0;
  const cappedFindingIds: string[] = [];
  const budgetRefusedFindingIds: string[] = [];
  let tokensSpent: RspTokenUsage | null = null;

  // 1. Partition: obvious findings pass straight through, unverified and un-chipped.
  const candidates: FindingElement[] = [];
  for (const finding of input.findings) {
    if (classifyNonObvious(finding)) candidates.push(finding);
    else decisions.set(finding.findingId, { kind: "keep" });
  }

  // 2. Rank candidates (high → medium → low, then findingId) and apply the cap. The
  //    over-cap remainder surfaces with an honest "not verified" caveat — never a
  //    silent skip that would read as an all-clear.
  const ranked = [...candidates].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareIds(a.findingId, b.findingId),
  );
  for (const finding of ranked.slice(maxVerifications)) {
    decisions.set(finding.findingId, {
      kind: "attach",
      verification: { verdict: "inconclusive", evidence: CAP_CAVEAT(maxVerifications) },
    });
    cappedFindingIds.push(finding.findingId);
    inconclusive += 1;
  }

  // 3. Resolve the real file window for each to-verify finding (a cheap read, no
  //    model turn). An unreadable window is an honest inconclusive.
  const resolved: ResolvedFinding[] = [];
  for (const finding of ranked.slice(0, maxVerifications)) {
    const window = await readWindowSafely(input.readFileWindow, finding.anchor);
    if (window === undefined) {
      decisions.set(finding.findingId, {
        kind: "attach",
        verification: { verdict: "inconclusive", evidence: UNREADABLE_CAVEAT },
      });
      inconclusive += 1;
      continue;
    }
    resolved.push({ finding, window });
  }

  // 4. Batch by file — findings sharing a file are ONE turn (the cost-bounding unit).
  const groups = new Map<string, ResolvedFinding[]>();
  for (const item of resolved) {
    const list = groups.get(item.window.path);
    if (list) list.push(item);
    else groups.set(item.window.path, [item]);
  }

  // 5. One budget-gated verification turn per file batch, in deterministic path order.
  for (const [path, members] of [...groups.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    const purpose = `finding-verification:${path}`;
    const grant: BudgetGrant = input.budget?.tryConsume(purpose) ?? budgetAbsentRefusal(purpose);
    if (!grant.granted) {
      for (const { finding } of members) {
        decisions.set(finding.findingId, {
          kind: "attach",
          verification: { verdict: "inconclusive", evidence: BUDGET_CAVEAT },
        });
        budgetRefusedFindingIds.push(finding.findingId);
        inconclusive += 1;
      }
      continue;
    }

    const refByFinding = new Map<string, FindingElement>();
    const promptFindings: VerificationPromptFinding[] = members.map(({ finding }, index) => {
      const ref = `f${index + 1}`;
      refByFinding.set(ref, finding);
      return {
        ref,
        severity: finding.severity,
        summary: finding.summary,
        hunk: hunkTextForAnchor(finding.anchor, input.manifest),
      };
    });
    const prompt = renderFindingVerificationPrompt(contract, {
      file: widestWindow(members),
      findings: promptFindings,
    });

    const turn = await input.runTurn(prompt);
    verificationTurns += 1;

    if (turn.status === "failed") {
      for (const { finding } of members) {
        decisions.set(finding.findingId, {
          kind: "attach",
          verification: { verdict: "inconclusive", evidence: turnFailedCaveat(turn.message) },
        });
        verifiedFindings += 1;
        inconclusive += 1;
      }
      continue;
    }
    if (turn.tokens) tokensSpent = addTokens(tokensSpent, turn.tokens);

    const verdictByRef = parseVerifications(turn.body);
    for (const [ref, finding] of refByFinding) {
      verifiedFindings += 1;
      const parsed = verdictByRef.get(ref);
      if (!parsed) {
        decisions.set(finding.findingId, {
          kind: "attach",
          verification: { verdict: "inconclusive", evidence: NO_VERDICT_CAVEAT },
        });
        inconclusive += 1;
        continue;
      }
      if (parsed.verdict === "refuted") {
        decisions.set(finding.findingId, { kind: "drop" });
        refuted += 1;
        continue;
      }
      if (parsed.verdict === "reproduced" && parsed.evidence.trim().length > 0) {
        decisions.set(finding.findingId, {
          kind: "attach",
          verification: { verdict: "reproduced", evidence: parsed.evidence.trim() },
        });
        reproduced += 1;
        continue;
      }
      // inconclusive — or a reproduced with no evidence, which is a guess, not proof.
      const evidence =
        parsed.evidence.trim().length > 0 ? parsed.evidence.trim() : NO_VERDICT_CAVEAT;
      decisions.set(finding.findingId, {
        kind: "attach",
        verification: { verdict: "inconclusive", evidence },
      });
      inconclusive += 1;
    }
  }

  // 6. Reassemble in ORIGINAL order: drop refuted, attach chips/caveats, keep the rest.
  const findings: FindingElement[] = [];
  for (const finding of input.findings) {
    const decision = decisions.get(finding.findingId) ?? { kind: "keep" };
    if (decision.kind === "drop") continue;
    if (decision.kind === "attach")
      findings.push({ ...finding, verification: decision.verification });
    else findings.push(finding);
  }

  return {
    findings,
    telemetry: {
      candidates: candidates.length,
      verifiedFindings,
      verificationTurns,
      reproduced,
      refuted,
      inconclusive,
      cappedFindingIds,
      budgetRefusedFindingIds,
      tokensSpent,
    },
  };
}

/**
 * The additive composition point (issue #179): verify a whole `FlaggedReview`. A
 * command that produced the reconciled findings (dual-model #41, or single-seat)
 * hands the review here and gets back the SAME review with refuted findings dropped
 * and reproduced/inconclusive chips attached — plus the cost telemetry. A `failed`
 * review is passed through untouched (there is nothing to verify), so this composes
 * after `runDualFindingReview` without changing the failed-vs-empty distinction. It
 * is purely additive: a caller that does not invoke it sees today's behaviour.
 */
export async function verifyFlaggedReview(
  review: FlaggedReview,
  options: Omit<RunFindingVerificationInput, "findings">,
): Promise<{ review: FlaggedReview; telemetry: VerificationTelemetry }> {
  if (review.status !== "ok") return { review, telemetry: emptyVerificationTelemetry() };
  const result = await runFindingVerification({ ...options, findings: review.findings });
  return {
    review: {
      status: "ok",
      findings: result.findings,
      ...(review.dual ? { dual: review.dual } : {}),
    },
    telemetry: result.telemetry,
  };
}

/**
 * Format the verification cost as the one-line delta the design asks for ("+N turns
 * / +M tokens for K verified findings"), optionally as a percent of a baseline token
 * count (e.g. the ~294K single-review baseline). Pure over the telemetry so a report
 * or the cost harness reads the SAME number the engine produced.
 */
export function describeVerificationCost(
  telemetry: VerificationTelemetry,
  baselineTotalTokens?: number,
): string {
  const tokens = telemetry.tokensSpent?.total ?? 0;
  const base = [
    `+${telemetry.verificationTurns} turn${telemetry.verificationTurns === 1 ? "" : "s"}`,
    `+${tokens} tokens`,
    `for ${telemetry.verifiedFindings} verified finding${telemetry.verifiedFindings === 1 ? "" : "s"}`,
  ].join(" / ");
  if (baselineTotalTokens === undefined || baselineTotalTokens <= 0) return base;
  const percent = ((tokens / baselineTotalTokens) * 100).toFixed(1);
  return `${base} (${percent}% of the ${baselineTotalTokens}-token baseline)`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The empty telemetry for a review that ran no verification (a failed flagged
 * review, or one with no findings). Every count zero; nothing dropped.
 */
export function emptyVerificationTelemetry(): VerificationTelemetry {
  return {
    candidates: 0,
    verifiedFindings: 0,
    verificationTurns: 0,
    reproduced: 0,
    refuted: 0,
    inconclusive: 0,
    cappedFindingIds: [],
    budgetRefusedFindingIds: [],
    tokensSpent: null,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalize the per-review cap, fail-closed on a bad value (Rule 75). A non-finite
 * cap (`NaN`/`Infinity`) would otherwise verify UNBOUNDED findings — the wrong-side
 * failure for the vital cost circuit — so it clamps to 0 (every non-obvious finding
 * surfaces with a "not verified" caveat; no unbounded spend). A negative cap is 0.
 */
function normalizeCap(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_VERIFICATIONS;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Read the window, coercing a thrown reader to `undefined` (an honest inconclusive, never a crash). */
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

/** The widest member window in a file batch (a real window from the file the batch shares). */
function widestWindow(members: readonly ResolvedFinding[]): VerificationFileWindow {
  let widest: VerificationFileWindow | undefined;
  for (const { window } of members) {
    if (
      widest === undefined ||
      window.endLine - window.startLine > widest.endLine - widest.startLine
    ) {
      widest = window;
    }
  }
  // Callers only invoke this on a non-empty file batch; the guard makes the
  // invariant explicit rather than reading an undefined index.
  if (widest === undefined) throw new Error("widestWindow requires at least one member");
  return widest;
}

/** Render a finding's own offered hunk (from the manifest) into the verifier's prompt; best-effort. */
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

/**
 * Parse a verification turn's emitted body into a ref → verdict map, defensively. A
 * malformed item is skipped (its finding then falls to the "no usable verdict"
 * caveat rather than being dropped), so a garbled emission never silently removes a
 * finding — only a clean `refuted` drops one.
 */
function parseVerifications(body: unknown): Map<string, ParsedVerdict> {
  const map = new Map<string, ParsedVerdict>();
  if (typeof body !== "object" || body === null) return map;
  const list = (body as { verifications?: unknown }).verifications;
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const ref = record.ref;
    const verdict = record.verdict;
    if (typeof ref !== "string") continue;
    if (verdict !== "reproduced" && verdict !== "refuted" && verdict !== "inconclusive") continue;
    map.set(ref, { verdict, evidence: typeof record.evidence === "string" ? record.evidence : "" });
  }
  return map;
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
