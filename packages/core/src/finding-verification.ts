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
 *      pass fed the REAL file content around its anchor (more than the offered hunk)
 *      AND a working shell in the repo (issue #259), so it can RUN the code — execute
 *      the test, reproduce the failure — rather than only reason about it. The commands
 *      it actually ran are observed and counted (`commandsRun`/`reproducedByExecution`),
 *      so a reproduced-by-running verdict is told apart from a reproduced-by-reading one.
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
 * Cost is bounded two ways, both consuming the shared invocation budget: only
 * non-obvious findings, and a per-review `maxVerifications` cap (verify the top-K by
 * severity, the rest surface caveated). Each verified finding is its own turn (#268
 * fix round 2), so the cap is also the ceiling on turns. Every bound is a caveat,
 * never a silent truncation.
 */

import {
  FINDING_VERIFICATION_CONTRACT,
  renderFindingVerificationPrompt,
  type VerificationContract,
} from "@rennet/prompts";
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
} from "@rennet/protocol";
import { parseAnchor, resolveAnchor } from "@rennet/protocol";
import { absentBudgetGrant } from "./invocation-budget";

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

/**
 * The honest "deep review ran but had no verifier" caveat (issue #179, P0-3). Deep
 * review with a Codex seat but NO Claude adapter still produces real findings, but the
 * verification turn needs the Claude adapter — so those findings would otherwise
 * surface with NO chip while deep review appears active, reading as "nothing to check"
 * when the truth is "we never checked." Absence of evidence must announce itself.
 */
export const VERIFIER_UNAVAILABLE_CAVEAT =
  "Not verified — no verifier was available for this review.";

/**
 * Stamp the verifier-unavailable caveat on every finding that WOULD have been verified
 * (non-obvious) but was not, because deep review ran without a verifier. Obvious
 * findings surface chip-less exactly as in the verified path (they never pay for a
 * turn, so an absent chip is honest for them), and a finding already carrying a chip is
 * left untouched. Pure over the review; a `failed` or non-ok review passes through. The
 * asymmetry matches the rest of #179: an unverifiable claim of a PROBLEM surfaces WITH
 * an honest inconclusive caveat, never a silent drop and never a false clear.
 */
export function markVerificationUnavailable(review: FlaggedReview): FlaggedReview {
  if (review.status !== "ok") return review;
  return {
    ...review,
    findings: review.findings.map((finding) =>
      finding.verification === undefined && classifyNonObvious(finding)
        ? {
            ...finding,
            verification: { verdict: "inconclusive", evidence: VERIFIER_UNAVAILABLE_CAVEAT },
          }
        : finding,
    ),
  };
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

/**
 * One command a verification turn ACTUALLY executed, as observed on the harness's
 * tool stream (issue #259) — the independent proof that reproduction ran, distinct
 * from whatever the model then wrote as its evidence. A turn that ran nothing carries
 * no execution at all (absent, never an empty-list masquerading as "ran, found none").
 */
export interface VerificationCommand {
  /** The command line the exec tool ran (e.g. the Bash `command`). */
  readonly command: string;
  /** Whether the harness reported the tool call succeeded. */
  readonly ok: boolean;
  /** A bounded tail of what the command printed — the executed evidence. */
  readonly outputTail: string;
}

/**
 * The executed evidence a verification turn carried (#259). `commands` are the exec
 * calls that COMPLETED — a `tool.started` paired with its `tool.output`, so the
 * command genuinely ran and produced output. `incomplete` are exec calls that started
 * but were denied or interrupted before any output (issue #268 F1): they are kept
 * separate and NEVER counted as a successful run, because a started-but-unpaired call
 * used to be recorded as `{ok: true}` — an unrun command reported as a clean one, the
 * permissive direction. Only `commands` are proof that anything executed.
 */
export interface VerificationExecution {
  readonly commands: readonly VerificationCommand[];
  /** Exec calls that started but never produced output (denied/interrupted) — not a run. */
  readonly incomplete?: readonly VerificationCommand[];
}

/** One batched verification turn's result (a fresh session emits `{ verifications }`). */
export type VerificationTurnResult =
  | {
      readonly status: "emitted";
      readonly body: unknown;
      readonly tokens?: RspTokenUsage;
      /** The commands the turn ran to reproduce (#259). Absent when it ran nothing. */
      readonly execution?: VerificationExecution;
    }
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
   * The shared live invocation budget (#260). Consulted before EVERY verification
   * turn — a turn over a CONFIGURED ceiling is refused (the affected findings
   * surface with a "not verified" caveat); an ABSENT budget runs UNGATED (no
   * ceiling, not no spend). Optional only as a test ergonomic.
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
  /**
   * Completed exec commands the harness OBSERVED across the verification turns (#259;
   * #268 F1: completed only — a denied/interrupted call is not counted). This is a
   * turn-level count of what actually ran, not a per-finding attribution.
   */
  readonly commandsRun: number;
  /**
   * Reproduced findings whose model-cited command MATCHED a command the harness
   * actually observed run (#268 F2). This is a per-FINDING count bound to observed
   * execution — NOT "the batch ran something", which is what the earlier turn-level
   * version wrongly credited to every reproduced finding in a file batch.
   */
  readonly reproducedByExecution: number;
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
  let commandsRun = 0;
  let reproducedByExecution = 0;
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

  // 4. One budget-gated verification turn PER FINDING (#268 fix round 2, option 2).
  //    Attribution is true BY CONSTRUCTION: every command a turn runs belongs to the ONE
  //    finding it verifies, so there is nothing to attribute between findings — no
  //    command-string matching, no consumption order, no misattribution. A reproduced
  //    verdict from a turn that ran a command is reproduced-by-execution; one whose own
  //    turn ran nothing is reproduced-by-reading. Deterministic order (rank, then id).
  for (const { finding, window } of resolved) {
    const purpose = `finding-verification:${finding.findingId}`;
    const grant: BudgetGrant = input.budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      decisions.set(finding.findingId, {
        kind: "attach",
        verification: { verdict: "inconclusive", evidence: BUDGET_CAVEAT },
      });
      budgetRefusedFindingIds.push(finding.findingId);
      inconclusive += 1;
      continue;
    }

    const prompt = renderFindingVerificationPrompt(contract, {
      file: window,
      findings: [
        {
          ref: "f1",
          severity: finding.severity,
          summary: finding.summary,
          hunk: hunkTextForAnchor(finding.anchor, input.manifest),
        },
      ],
    });

    const turn = await input.runTurn(prompt);
    verificationTurns += 1;
    verifiedFindings += 1;

    if (turn.status === "failed") {
      decisions.set(finding.findingId, {
        kind: "attach",
        verification: { verdict: "inconclusive", evidence: turnFailedCaveat(turn.message) },
      });
      inconclusive += 1;
      continue;
    }
    if (turn.tokens) tokensSpent = addTokens(tokensSpent, turn.tokens);
    // The commands the harness OBSERVED this turn run (issue #259) — completed exec calls
    // only (a started-but-denied call is not here, #268 F1). Because the turn verified
    // exactly THIS finding, every observed command was run for it: a reproduced verdict
    // from a turn that ran ≥1 command is execution-backed, no matching required.
    const ranCommands = turn.execution?.commands ?? [];
    commandsRun += ranCommands.length;

    const parsed = parseSingleVerification(turn.body);
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
      // Executed-backed when THIS finding's own turn ran a command; the surfaced evidence
      // is then GROUNDED in the observed command + its real output, not the model's prose.
      const evidence =
        ranCommands.length > 0
          ? executedEvidence(parsed.evidence.trim(), ranCommands)
          : parsed.evidence.trim();
      decisions.set(finding.findingId, {
        kind: "attach",
        verification: { verdict: "reproduced", evidence },
      });
      reproduced += 1;
      if (ranCommands.length > 0) reproducedByExecution += 1;
      continue;
    }
    // inconclusive — or a reproduced with no evidence, which is a guess, not proof.
    const evidence = parsed.evidence.trim().length > 0 ? parsed.evidence.trim() : NO_VERDICT_CAVEAT;
    decisions.set(finding.findingId, {
      kind: "attach",
      verification: { verdict: "inconclusive", evidence },
    });
    inconclusive += 1;
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
      commandsRun,
      reproducedByExecution,
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
    commandsRun: 0,
    reproducedByExecution: 0,
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
 * Parse the single verdict from a one-finding verification turn's emitted body,
 * defensively (#268 fix round 2: one finding per turn, so there is exactly one verdict
 * to read). Returns the FIRST well-formed verification; a garbled/empty emission returns
 * `undefined`, so the finding falls to the "no usable verdict" caveat rather than being
 * dropped — only a clean `refuted` drops one.
 */
function parseSingleVerification(body: unknown): ParsedVerdict | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const list = (body as { verifications?: unknown }).verifications;
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const verdict = record.verdict;
    if (verdict !== "reproduced" && verdict !== "refuted" && verdict !== "inconclusive") continue;
    return { verdict, evidence: typeof record.evidence === "string" ? record.evidence : "" };
  }
  return undefined;
}

/** A compact one-line excerpt of a command's output tail, for the evidence chip. */
function outputExcerpt(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * The surfaced evidence for a reproduced-by-EXECUTION finding: the model's one-line
 * reasoning GROUNDED in a command the harness actually observed this finding's turn run
 * and what it printed — the executed proof comes from observed data, not from the model's
 * prose (#268 F2), and needs no attribution because the turn verified this finding alone
 * (#268 fix round 2). Uses the turn's LAST observed command, which is typically the
 * reproduction after any exploration.
 */
function executedEvidence(reasoning: string, ran: readonly VerificationCommand[]): string {
  const observed = ran[ran.length - 1];
  if (observed === undefined) return reasoning;
  const command =
    observed.command.length <= 200 ? observed.command : `${observed.command.slice(0, 200)}…`;
  const excerpt = outputExcerpt(observed.outputTail);
  const proof = excerpt.length > 0 ? `ran \`${command}\` → ${excerpt}` : `ran \`${command}\``;
  return reasoning.length > 0 ? `${reasoning} (${proof})` : proof;
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
