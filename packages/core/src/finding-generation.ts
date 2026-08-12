/**
 * The diff-to-findings transformation for the Flagged lens (issue #32 / #138).
 *
 * This is the first genuinely-real AI review: a live model reasons over the
 * offered hunks of a change and PRODUCES the `finding` documents the Flagged lens
 * renders, replacing the fixture that stood behind the `flagged.review` boundary.
 * It mirrors `runDecompositionAngle` (#8): the offered manifest an agent may cite
 * (deterministic), the prompt contract that instructs it (from `@rennet/instructions`),
 * and the RSP validator that decides admission (from `@rennet/protocol`). The agent
 * emits ONLY the body, schema-constrained; this module builds the trustworthy
 * envelope around it — minting the `docId`, stamping `provenance` including
 * `inputDigest` — so "agents never mint identity" is structural, not instruction.
 *
 * Two things differ from the decomposition angle, both because a finding is a
 * MODEL JUDGEMENT rather than a partition of a fixed set:
 *
 *   1. There is NO deterministic floor. A change's real concerns cannot be
 *      derived mechanically, so terminal failure resolves to an honest `failed`
 *      state — never a manufactured finding. The Flagged lens keeps "ran clean"
 *      (an admitted, possibly-empty set) strictly apart from "the runner did not
 *      complete" (`failed`), and this runner preserves that distinction.
 *   2. Findings are culled to the GROUNDED ones before the gate: a finding whose
 *      anchor does not resolve to an offered hunk (a hallucinated location), or
 *      whose summary is empty, or whose severity is not the closed vocabulary, is
 *      dropped rather than allowed to reject the whole document. This is the
 *      itemwise spirit the `finding` doctype declares (a lone bad finding never
 *      sinks the grounded ones), and it is the "verifier cull before display"
 *      the Flagged lens rubric calls for. The AGREEMENT/vote is the runner's to
 *      own (a single model concurs with itself, 1 of 1) — the model judges the
 *      code, never certifies its own vote.
 */

import {
  type AssembleOptions,
  assemblePrompt,
  FINDING_CONTRACT,
  type PromptContract,
  renderBaseInstruction,
  renderConventionLayer,
  renderHypothesisLayer,
} from "@rennet/instructions";
import { computeInputDigest, parseAnchor, resolveAnchor, validateDocument } from "@rennet/protocol";
import type {
  BudgetGrant,
  ConventionCatalogue,
  FindingBody,
  FindingElement,
  FindingSeverity,
  InvocationBudget,
  OfferedManifest,
  ResolutionTrace,
  ReviewHypothesis,
  RspCapabilitySnapshot,
  RspEnvelope,
  RspModelReportedBy,
  RspProvenance,
  RspTokenUsage,
  ValidationReport,
} from "@rennet/types";
import { absentBudgetGrant } from "./invocation-budget";

/** The result of one finding turn: the emitted body, or a turn-level failure. */
export type FindingTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface FindingProvenanceSeed {
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

/**
 * The change's stated intent (issue #136). The finding runner reasons over the diff
 * PLUS this — the PR title/body and the spec when present — so a concern can be
 * measured against what the change SET OUT to do, not just what the code shows. Every
 * field is optional: absent, the runner reasons over the diff alone (the honest
 * degrade, byte-identical to before capture landed). Structurally identical to the
 * Decisions runner's `DecisionIntent` and the `ReviewIntent` the intent projection
 * emits (`patchsetIntentToReviewIntent`), so the one projected value feeds all three —
 * kept as a local type to hold the finding runner parallel to the decision runner.
 */
export interface FindingIntent {
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly spec?: string;
}

export interface RunFindingAngleInput {
  /** The patchset the offered manifest was built over; anchors resolve against it. */
  readonly patchsetId: string;
  /** The offered occurrence manifest: the hunk ids + lines the model may cite. */
  readonly manifest: OfferedManifest;
  /** The change's stated intent (PR title/body, spec); the runner reasons over it + the diff (#136). */
  readonly intent?: FindingIntent;
  /**
   * The committed hypothesis (#178). When present, it is rendered as a labelled
   * disconfirmation layer positioned after the base instruction and before the
   * payload — so the runner checks "did the author diverge from what we'd have
   * done" for each predicted risk. Absent, the runner assembles and runs exactly
   * as it does today, with no hypothesis layer.
   */
  readonly hypothesis?: ReviewHypothesis;
  /**
   * The per-project convention / anti-pattern catalogue (#180). When present with
   * at least one rule, it is rendered as a labelled checklist layer positioned
   * after the hypothesis and before the general guidance — so the runner checks
   * the change against the project's established conventions and reports the
   * underlying REASON (never a rule number) when it diverges. Absent or empty, the
   * runner assembles exactly as it does today, with no conventions layer.
   */
  readonly conventions?: ConventionCatalogue;
  /** The `finding` contract; defaults to the shipped `FINDING_CONTRACT` (#32). */
  readonly contract?: PromptContract;
  readonly provenance: FindingProvenanceSeed;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<FindingTurnResult>;
  /** Optional repo guidance layers, wrapped as untrusted material by the assembler. */
  readonly guidance?: { readonly general?: string; readonly files?: string };
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, #95). Consulted before EVERY
   * turn — a turn over a CONFIGURED ceiling is refused; an ABSENT budget runs
   * UNGATED (#260: no budget means no ceiling, not no spend). A
   * refusal is terminal for this runner: no turn runs and the review resolves to
   * the honest `failed` state (never a fabricated finding). Optional only as a
   * test ergonomic; a real caller must thread one to run turns.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

export interface FindingAttempt {
  readonly attempt: number;
  /**
   * `malformed-body`: the turn emitted, but the body was not a finding document
   * (not an object with a `findings` array). It is recorded as its own fact —
   * distinct from `turn-failed` (the turn never emitted) and from an admitted
   * empty review — because a model that returned an unparseable shape has NOT
   * reviewed the code, and must never be reported as a clean, empty review.
   */
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "malformed-body" | "budget-refused";
  /** The validation report for an attempt that produced a body; absent on a turn failure. */
  readonly report?: ValidationReport;
  readonly turnError?: string;
  /** The typed refusal when the budget refused this attempt at runtime (R10). */
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
  /** How many model-emitted findings were dropped as ungrounded before the gate. */
  readonly culledCount?: number;
}

export interface RunFindingAngleResult {
  /**
   * `ok` — the runner completed and produced a (possibly empty) grounded set of
   * findings. `failed` — the runner did not complete (every turn failed, or the
   * budget refused). These map onto the Flagged lens's load-bearing distinction:
   * "ran clean" is NEVER conflated with "did not run".
   */
  readonly status: "ok" | "failed";
  /** The admitted, grounded findings (empty on `ok` when nothing survived the cull). */
  readonly findings: FindingElement[];
  /** The emitted `finding` document, present when a turn produced an admitted body. */
  readonly document?: RspEnvelope;
  readonly report?: ValidationReport;
  readonly attempts: FindingAttempt[];
  /** True when the live invocation budget refused a turn at runtime (R10 ceiling hit). */
  readonly budgetRefused: boolean;
  /** The reason for a `failed` status, for the lens's LOUD failed state. */
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

const SEVERITIES = new Set<FindingSeverity>(["high", "medium", "low"]);

/** A compact, model-facing serialisation of the change's stated intent, when present. */
function renderIntent(intent: FindingIntent | undefined): string | undefined {
  if (intent === undefined) return undefined;
  const parts: Record<string, string> = {};
  if (intent.prTitle !== undefined && intent.prTitle.trim().length > 0)
    parts.prTitle = intent.prTitle;
  if (intent.prBody !== undefined && intent.prBody.trim().length > 0) parts.prBody = intent.prBody;
  if (intent.spec !== undefined && intent.spec.trim().length > 0) parts.spec = intent.spec;
  if (Object.keys(parts).length === 0) return undefined;
  return JSON.stringify({ intent: parts }, null, 2);
}

/** A compact, model-facing serialisation of the offered hunks and their lines. */
function renderPayload(manifest: OfferedManifest, patchsetId: string): string {
  const hunks = manifest.occurrences
    .filter((occurrence) => occurrence.kind === "hunk")
    .map((occurrence) => ({
      id: occurrence.id,
      additions: occurrence.sides?.additions ?? [],
      deletions: occurrence.sides?.deletions ?? [],
      context: occurrence.sides?.context ?? [],
    }));
  return JSON.stringify({ patchsetId, hunks }, null, 2);
}

/** Format a validation report into the machine-readable text fed back on retry. */
function renderReport(report: ValidationReport): string {
  const lines = report.errors.map(
    (error) => `- ${error.code} at ${error.pointer}: ${error.message}`,
  );
  return `The previous document was REJECTED. Fix every error and re-emit:\n${lines.join("\n")}`;
}

/** True iff a `rennet:` anchor parses AND resolves to an offered occurrence. */
function isGroundedAnchor(anchor: string, manifest: OfferedManifest): boolean {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return false;
  return resolveAnchor(parsed.anchor, manifest).outcome === "resolved";
}

/**
 * The result of culling a model emission. `malformed` is the load-bearing
 * distinction: a body that is not a finding document (not an object with a
 * `findings` array) is a fact APART from a well-formed body whose findings
 * happen to be empty. A model that flagged nothing has reviewed the code; a
 * model that returned an unparseable shape has not — and only the first is a
 * clean review. Returning a discriminated union removes the ambiguity
 * STRUCTURALLY: the caller cannot read `findings` off a malformed body, because
 * there is none to read (#158).
 */
type CullResult =
  | { readonly malformed: true }
  | { readonly malformed: false; readonly findings: FindingElement[]; readonly culled: number };

/**
 * Cull the model's emitted findings to the GROUNDED, well-formed ones and stamp
 * the runner-owned fields. A body that is not a finding document is reported as
 * `malformed` and NOT collapsed to an empty set (#158) — the caller routes it to
 * the failed path, never to a clean review. Otherwise, kept: a finding with a
 * string anchor that resolves to an offered hunk, a non-empty summary, and a
 * severity in the closed vocabulary. Dropped: anything else (a hallucinated
 * anchor, a word-less flag, a bad severity) — never surfaced, so a lone bad
 * finding cannot sink the grounded ones. The `findingId` is minted here (agents
 * never mint identity), and the AGREEMENT is the runner's authority: a single
 * model concurs with itself, 1 of 1.
 */
function cullFindings(
  body: unknown,
  manifest: OfferedManifest,
  mintDocId: () => string,
): CullResult {
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { findings?: unknown }).findings)
  ) {
    return { malformed: true };
  }
  const raw = (body as { findings: unknown[] }).findings;
  const findings: FindingElement[] = [];
  let culled = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      culled += 1;
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const anchor = candidate.anchor;
    const summary = candidate.summary;
    const severity = candidate.severity;
    if (
      typeof anchor !== "string" ||
      typeof summary !== "string" ||
      summary.trim().length === 0 ||
      typeof severity !== "string" ||
      !SEVERITIES.has(severity as FindingSeverity) ||
      !isGroundedAnchor(anchor, manifest)
    ) {
      culled += 1;
      continue;
    }
    findings.push({
      findingId: mintDocId(),
      anchor,
      summary,
      severity: severity as FindingSeverity,
      // The single-model MVP: the runner owns the vote, the model owns the words.
      agreement: { kind: "concur", agree: 1, total: 1 },
    });
  }
  return { malformed: false, findings, culled };
}

function buildProvenance(
  seed: FindingProvenanceSeed,
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
  body: FindingBody,
  patchsetId: string,
  provenance: RspProvenance,
  docId: string,
): RspEnvelope {
  return {
    rsp: 1,
    docType: "finding",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
}

/**
 * Drive one finding angle to a validator-admitted `finding` document. Assembles
 * the contract prompt, runs the injected turn, culls the emitted findings to the
 * grounded set, stamps a trustworthy envelope, and validates. On a turn failure
 * or an (unexpected) rejection it retries with the report fed back — falling to
 * the honest `failed` state on terminal failure, never a fabricated finding.
 */
export async function runFindingAngle(input: RunFindingAngleInput): Promise<RunFindingAngleResult> {
  const {
    patchsetId,
    manifest,
    intent,
    contract = FINDING_CONTRACT,
    provenance: seed,
    runTurn,
    guidance,
    assembleOptions,
    maxRetries = 2,
    budget,
  } = input;
  const mintDocId = input.mintDocId ?? defaultMintDocId;
  const newRunId = input.newRunId ?? defaultRunId;

  const patchsetRef = { id: patchsetId };
  const inputDigest = computeInputDigest(patchsetRef, manifest);
  const base = renderBaseInstruction(contract);
  const payload = renderPayload(manifest, patchsetId);
  const intentText = renderIntent(intent);
  const hypothesisLayer =
    input.hypothesis === undefined ? undefined : renderHypothesisLayer(input.hypothesis);
  // The per-project convention checklist (#180). An absent catalogue, or one with
  // no rules, yields no layer — the assembled prompt is byte-identical to today.
  const conventionLayer =
    input.conventions === undefined || input.conventions.rules.length === 0
      ? undefined
      : renderConventionLayer(input.conventions);

  const attempts: FindingAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;
  let lastFailure = "the finding runner did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal for this runner and resolves to the honest failed
    // state (a finding is a judgement, so there is no floor to fall to).
    const purpose = `finding:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      attempts.push({ attempt, outcome: "budget-refused", budgetRefusal: grant });
      budgetRefused = true;
      lastFailure = grant.reason;
      break;
    }

    // The intent rides the `task` slot and the retry report is appended to it, so a
    // rejection's feedback never displaces the change's stated intent. Absent an intent
    // (and on the first attempt with no report), the slot is empty and the assembled
    // prompt is byte-identical to before intent capture reached the finding runner.
    const taskText = [intentText, lastReportText].filter((part) => part !== undefined).join("\n\n");
    const assembled = assemblePrompt(
      {
        base,
        ...(hypothesisLayer === undefined ? {} : { hypothesis: hypothesisLayer }),
        ...(conventionLayer === undefined ? {} : { conventions: conventionLayer }),
        ...(guidance?.general === undefined ? {} : { general: guidance.general }),
        ...(guidance?.files === undefined ? {} : { files: guidance.files }),
        ...(taskText.length === 0 ? {} : { task: taskText }),
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

    const cullResult = cullFindings(turn.body, manifest, mintDocId);
    if (cullResult.malformed) {
      // A body that is not a finding document is NOT a clean review: the model
      // did not review the code, it returned an unparseable shape. Route it to
      // the failed path (retry, then the honest LOUD failed state) — never
      // `{ findings: [] }`, which would report a review that ran clean (#158).
      attempts.push({
        attempt,
        outcome: "malformed-body",
        turnError: "the model emitted a body that is not a finding document",
      });
      lastFailure = "the model emitted a malformed finding body";
      continue;
    }
    const { findings, culled } = cullResult;
    const body: FindingBody = { findings };
    const provenance = buildProvenance(seed, inputDigest, newRunId(), turn.tokens ?? ZERO_TOKENS);
    const document = buildEnvelope(body, patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    if (report.admitted) {
      attempts.push({ attempt, outcome: "admitted", report, culledCount: culled });
      return { status: "ok", findings, document, report, attempts, budgetRefused };
    }
    // The runner culls to a set that should always admit; a rejection here is
    // unexpected, so feed the report back and retry rather than surface a
    // partially-validated document as findings.
    attempts.push({ attempt, outcome: "rejected", report, culledCount: culled });
    lastReportText = renderReport(report);
    lastFailure = "the finding document was rejected by the validator";
  }

  // Terminal failure: no floor to invent. The lens renders the LOUD failed state.
  return {
    status: "failed",
    findings: [],
    attempts,
    budgetRefused,
    failureReason: lastFailure,
  };
}
