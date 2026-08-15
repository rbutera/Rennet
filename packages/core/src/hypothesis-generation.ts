/**
 * The hypothesis-first pre-read pass (issue #178).
 *
 * Florence's single most load-bearing anti-rubber-stamp move, ported into Rennet:
 * BEFORE any lens runner reads a hunk, a live model commits to a PRIOR — the
 * change's Domain, its in/out Scope, the Design we would have chosen, and 5-10
 * concrete Risks with disconfirmers — from the change's stated INTENT, its
 * STRUCTURE (the changed-file list + decomposition chunk titles), and the REPO
 * CONTEXT, but deliberately NOT the code hunks. That committed hypothesis then
 * feeds every lens runner as a labelled disconfirmation layer and surfaces to the
 * human as their reading frame.
 *
 * It mirrors `runFindingAngle` (#32) exactly: the offered manifest for identity
 * (inputDigest binds the doc to the patchset — even though the pass cites no
 * hunks), the prompt contract that instructs it (`REVIEW_HYPOTHESIS_CONTRACT` from
 * `@rennet/instructions`), and the RSP validator that decides admission (from
 * `@rennet/protocol`). The agent emits ONLY the body, schema-constrained; this
 * module builds the trustworthy envelope around it — minting the `docId`, stamping
 * `provenance` including `inputDigest`, and minting each risk's `riskId` — so
 * "agents never mint identity" is structural, not instruction.
 *
 * Two things are load-bearing:
 *
 *   1. It is a GENUINE PRIOR, not a diff summary. The pass is fed the shape of the
 *      change (intent + structure + repo context), never the hunk bodies — so its
 *      risks are expectations to check rather than a restatement of the code. The
 *      caller renders those three inputs into the payload; the hunks are absent by
 *      construction.
 *   2. There is NO deterministic floor (a hypothesis is a judgement), and the doc
 *      is ATOMIC — a subject-less hypothesis, a bad risk count, or a word-less risk
 *      rejects the WHOLE document (unlike an itemwise finding set), the report is
 *      fed back, and terminal failure resolves to an honest `failed` state, never a
 *      manufactured hypothesis. A pass that ran and produced a hypothesis (`ok`) is
 *      kept strictly apart from one that did not complete (`failed`).
 */

import {
  type AssembleOptions,
  assemblePrompt,
  type PromptContract,
  REVIEW_HYPOTHESIS_CONTRACT,
  renderBaseInstruction,
} from "@rennet/instructions";
import { canonicalize, computeInputDigest, sha256Hex, validateDocument } from "@rennet/protocol";
import type {
  BudgetGrant,
  HypothesisRepoContext,
  HypothesisRisk,
  HypothesisStructure,
  InvocationBudget,
  OfferedManifest,
  ResolutionTrace,
  ReviewHypothesis,
  ReviewHypothesisBody,
  ReviewIntent,
  RspCapabilitySnapshot,
  RspEnvelope,
  RspModelReportedBy,
  RspProvenance,
  RspTokenUsage,
  ValidationReport,
} from "@rennet/types";
import { absentBudgetGrant } from "./invocation-budget";

/** The result of one hypothesis turn: the emitted body, or a turn-level failure. */
export type HypothesisTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface HypothesisProvenanceSeed {
  readonly harness: string;
  readonly harnessVersion: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly modelReportedBy: RspModelReportedBy;
  readonly capability: RspCapabilitySnapshot;
  /** The Model Council effort for this seat, when the council resolved it (#69). */
  readonly effort?: string;
  /** The Model Council resolution trace, when the council resolved this seat (#69). */
  readonly resolutionTrace?: ResolutionTrace;
}

export interface RunHypothesisPassInput {
  /** The patchset the offered manifest was built over; the doc's inputDigest binds to it. */
  readonly patchsetId: string;
  /** The offered occurrence manifest: used for identity (inputDigest), not cited by the pass. */
  readonly manifest: OfferedManifest;
  /** The change's stated intent (PR title/body, spec); absent → structure-only prior. */
  readonly intent?: ReviewIntent;
  /** The change's structure the pass sees INSTEAD of hunk bodies (files + chunk titles). */
  readonly structure: HypothesisStructure;
  /** A compact projection of the ProjectSnapshot; absent/empty → the prior notes it as absent. */
  readonly repoContext?: HypothesisRepoContext;
  /** The `review.hypothesis` contract; defaults to the shipped one (#178). */
  readonly contract?: PromptContract;
  readonly provenance: HypothesisProvenanceSeed;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<HypothesisTurnResult>;
  /** Optional repo guidance layers, wrapped as untrusted material by the assembler. */
  readonly guidance?: { readonly general?: string; readonly files?: string };
  readonly assembledContext?: string;
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, #95). Consulted before EVERY
   * turn — a turn over a CONFIGURED ceiling is refused; an ABSENT budget runs
   * UNGATED (#260: no budget means no ceiling, not no spend). A
   * refusal is terminal for this pass: no turn runs and it resolves to the honest
   * `failed` state (never a fabricated hypothesis). Optional only as a test
   * ergonomic; a real caller must thread one to run turns.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
  readonly mintRiskId?: () => string;
}

export interface HypothesisAttempt {
  readonly attempt: number;
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "budget-refused";
  /** The validation report for an attempt that produced a body; absent on a turn failure. */
  readonly report?: ValidationReport;
  readonly turnError?: string;
  /** The typed refusal when the budget refused this attempt at runtime (R10). */
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
}

export interface RunHypothesisResult {
  /**
   * `ok` — the pass completed and produced an admitted hypothesis. `failed` — the
   * pass did not complete (every turn failed, or the budget refused). Downstream
   * treats `failed` as "no hypothesis," never as an empty-but-successful one.
   */
  readonly status: "ok" | "failed";
  /** The extracted, ready-to-inject hypothesis, present on `ok`. */
  readonly hypothesis?: ReviewHypothesis;
  /** The emitted `review.hypothesis` document, present when a turn produced an admitted body. */
  readonly document?: RspEnvelope;
  readonly report?: ValidationReport;
  readonly attempts: HypothesisAttempt[];
  /** True when the live invocation budget refused a turn at runtime (R10 ceiling hit). */
  readonly budgetRefused: boolean;
  /** The reason for a `failed` status, for the honest failed state. */
  readonly failureReason?: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-char Crockford base32 id (ULID-shaped), the adapter's minted identity. */
function defaultMintDocId(): string {
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out += CROCKFORD.charAt(Math.floor(Math.random() * CROCKFORD.length));
  }
  return out;
}

/** Content-address one risk by its patchset and meaning, never by run or list position. */
function defaultMintRiskId(
  patchsetId: string,
  risk: Pick<HypothesisRisk, "statement" | "severity" | "disconfirmer">,
): string {
  return sha256Hex(
    canonicalize({
      patchsetId,
      statement: risk.statement,
      severity: risk.severity,
      disconfirmer: risk.disconfirmer,
    }),
  );
}

function defaultRunId(): string {
  return `run_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const ZERO_TOKENS: RspTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 0,
};

/** True iff the repo context carries any content (a summary or at least one file). */
export function hasRepoContext(repoContext: HypothesisRepoContext | undefined): boolean {
  if (repoContext === undefined) return false;
  const hasSummary =
    typeof repoContext.summary === "string" && repoContext.summary.trim().length > 0;
  const hasFiles = Array.isArray(repoContext.files) && repoContext.files.length > 0;
  return hasSummary || hasFiles;
}

/**
 * Stamp a `riskId` onto every risk the model emitted (agents never mint identity).
 * Malformed risks are passed through with an id so the validator's atomic gate
 * rejects the WHOLE document with a precise code (V153/V154/V155) and the report
 * is fed back — the pass never silently drops a risk to reach a clean count.
 */
function stampRiskIds(
  body: unknown,
  patchsetId: string,
  mintRiskId?: () => string,
): ReviewHypothesisBody {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const domain = typeof record.domain === "string" ? record.domain : "";
  const designExpectation =
    typeof record.designExpectation === "string" ? record.designExpectation : "";
  const scopeRecord =
    typeof record.scope === "object" && record.scope !== null
      ? (record.scope as Record<string, unknown>)
      : {};
  const inScope = Array.isArray(scopeRecord.inScope)
    ? scopeRecord.inScope.filter((item): item is string => typeof item === "string")
    : [];
  const outOfScope = Array.isArray(scopeRecord.outOfScope)
    ? scopeRecord.outOfScope.filter((item): item is string => typeof item === "string")
    : [];
  const rawRisks = Array.isArray(record.risks) ? record.risks : [];
  const risks: HypothesisRisk[] = rawRisks.map((raw) => {
    const risk = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const stampedRisk = {
      statement: typeof risk.statement === "string" ? risk.statement : "",
      // Severity is passed through as-emitted; the shape schema (V108) rejects an
      // out-of-vocabulary value, so a bad severity rejects the whole doc.
      severity: risk.severity as HypothesisRisk["severity"],
      disconfirmer: typeof risk.disconfirmer === "string" ? risk.disconfirmer : "",
    };
    return {
      riskId: mintRiskId?.() ?? defaultMintRiskId(patchsetId, stampedRisk),
      ...stampedRisk,
    };
  });
  return { domain, scope: { inScope, outOfScope }, designExpectation, risks };
}

function buildProvenance(
  seed: HypothesisProvenanceSeed,
  inputDigest: string,
  runId: string,
  tokens: RspTokenUsage,
): RspProvenance {
  return {
    harness: seed.harness,
    harnessVersion: seed.harnessVersion,
    adapterVersion: seed.adapterVersion,
    model: seed.model,
    modelReportedBy: seed.modelReportedBy,
    tier: "heavy",
    route: "agentic",
    runId,
    inputDigest,
    capability: seed.capability,
    tokens,
    reportedUsd: null,
    derivedUsd: null,
    ...(seed.effort === undefined ? {} : { effort: seed.effort }),
    ...(seed.resolutionTrace === undefined ? {} : { resolutionTrace: seed.resolutionTrace }),
  };
}

function buildEnvelope(
  body: ReviewHypothesisBody,
  patchsetId: string,
  provenance: RspProvenance,
  docId: string,
): RspEnvelope {
  return {
    rsp: 1,
    docType: "review.hypothesis",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
}

/**
 * A compact, model-facing serialisation of the genuine-prior inputs: the change's
 * intent, its structure (files + chunk titles), and the repo context — but NEVER
 * the hunk bodies. This is the payload the pass reasons over.
 */
function renderPriorInputs(input: RunHypothesisPassInput, repoContextPresent: boolean): string {
  const intent: Record<string, string> = {};
  if (input.intent?.prTitle !== undefined && input.intent.prTitle.trim().length > 0)
    intent.prTitle = input.intent.prTitle;
  if (input.intent?.prBody !== undefined && input.intent.prBody.trim().length > 0)
    intent.prBody = input.intent.prBody;
  if (input.intent?.spec !== undefined && input.intent.spec.trim().length > 0)
    intent.spec = input.intent.spec;
  const payload = {
    intent: Object.keys(intent).length > 0 ? intent : undefined,
    structure: {
      changedFiles: input.structure.changedFiles,
      chunkTitles: input.structure.chunkTitles,
    },
    repoContext: repoContextPresent ? input.repoContext : undefined,
    repoContextPresent,
  };
  return JSON.stringify(payload, null, 2);
}

/** Format a validation report into the machine-readable text fed back on retry. */
function renderReport(report: ValidationReport): string {
  const lines = report.errors.map(
    (error) => `- ${error.code} at ${error.pointer}: ${error.message}`,
  );
  return `The previous document was REJECTED. Fix every error and re-emit:\n${lines.join("\n")}`;
}

/**
 * Drive the hypothesis pass to a validator-admitted `review.hypothesis` document.
 * Assembles the contract prompt (the base instruction, and the genuine-prior
 * inputs under the payload slot — intent + structure + repo context, never the
 * hunks), runs the injected turn, stamps riskIds, builds a trustworthy envelope,
 * and validates atomically. On a turn failure or a rejection it retries with the
 * report fed back — falling to the honest `failed` state on terminal failure,
 * never a fabricated hypothesis.
 */
export async function runHypothesisPass(
  input: RunHypothesisPassInput,
): Promise<RunHypothesisResult> {
  const {
    patchsetId,
    manifest,
    contract = REVIEW_HYPOTHESIS_CONTRACT,
    provenance: seed,
    runTurn,
    guidance,
    assembleOptions,
    maxRetries = 2,
    budget,
  } = input;
  const mintDocId = input.mintDocId ?? defaultMintDocId;
  const newRunId = input.newRunId ?? defaultRunId;

  const repoContextPresent = hasRepoContext(input.repoContext);
  const patchsetRef = { id: patchsetId };
  const inputDigest = computeInputDigest(patchsetRef, manifest);
  const base = renderBaseInstruction(contract);
  const payload = renderPriorInputs(input, repoContextPresent);

  const attempts: HypothesisAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;
  let lastFailure = "the hypothesis pass did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal and resolves to the honest failed state (no floor).
    const purpose = `hypothesis:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      attempts.push({ attempt, outcome: "budget-refused", budgetRefusal: grant });
      budgetRefused = true;
      lastFailure = grant.reason;
      break;
    }

    const assembled = assemblePrompt(
      {
        base,
        ...(guidance?.general === undefined ? {} : { general: guidance.general }),
        ...(guidance?.files === undefined ? {} : { files: guidance.files }),
        ...(lastReportText === undefined ? {} : { task: lastReportText }),
        ...(input.assembledContext === undefined ? {} : { context: input.assembledContext }),
        payload,
      },
      assembleOptions ?? {},
    );

    const turn = await runTurn(assembled.text, attempt);
    if (turn.status === "failed") {
      attempts.push({ attempt, outcome: "turn-failed", turnError: turn.message });
      lastFailure = turn.message;
      continue;
    }

    const body = stampRiskIds(turn.body, patchsetId, input.mintRiskId);
    const provenance = buildProvenance(seed, inputDigest, newRunId(), turn.tokens ?? ZERO_TOKENS);
    const document = buildEnvelope(body, patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    if (report.admitted) {
      attempts.push({ attempt, outcome: "admitted", report });
      const hypothesis: ReviewHypothesis = { ...body, repoContextPresent };
      return { status: "ok", hypothesis, document, report, attempts, budgetRefused };
    }
    attempts.push({ attempt, outcome: "rejected", report });
    lastReportText = renderReport(report);
    lastFailure = "the hypothesis document was rejected by the validator";
  }

  return {
    status: "failed",
    attempts,
    budgetRefused,
    failureReason: lastFailure,
  };
}
