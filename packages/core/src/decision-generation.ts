/**
 * The diff-to-decisions transformation for the Decisions lens (issue #137).
 *
 * The Decisions lens shows the calls the implementer actually made — "keyed the
 * store per repo root, not per branch", "chose fail-closed carry on a truncated
 * patch" — each a plain-language decision with the evidence it is drawn from and a
 * reconstructed why (marked reconstructed, a starting read the reviewer can
 * overturn, never a claim of fact), grouped by theme. The producer SURFACE already
 * shipped (`projectDecisions`, #137, fixture-backed); this is the LIVE runner that
 * replaces the fixture: a real model reasons over {the offered hunks of the change
 * + the change's stated intent (PR title/body, spec)} and PRODUCES the
 * `decision.record` documents the lens renders.
 *
 * It mirrors `runFindingAngle` (#32): the offered manifest an agent may cite
 * (deterministic), the prompt contract that instructs it (`DECISION_CONTRACT` from
 * `@rennet/instructions`), and the RSP validator that decides admission (from
 * `@rennet/protocol`). The agent emits ONLY the body, schema-constrained; this
 * module builds the trustworthy envelope around it — minting the `docId`, stamping
 * `provenance` including `inputDigest` — so "agents never mint identity" is
 * structural, not instruction.
 *
 * Three things are load-bearing, all inherited from the finding runner because a
 * decision, like a finding, is a MODEL JUDGEMENT rather than a partition of a fixed
 * set:
 *
 *   1. There is NO deterministic floor. A change's real decisions cannot be derived
 *      mechanically, so terminal failure resolves to an honest `failed` state —
 *      never a manufactured decision. The Decisions lens keeps "ran, nothing
 *      discerned" (an admitted, possibly-empty set) strictly apart from "the runner
 *      did not complete" (`failed`), and this runner preserves that distinction.
 *   2. Decisions are culled to the GROUNDED, well-formed ones before the gate: a
 *      decision whose anchor does not resolve to an offered hunk (a hallucinated
 *      location), whose title is empty, or which smuggles a stray `rennet:` anchor
 *      into a non-anchor field, is dropped rather than allowed to reject its item.
 *      This is the itemwise spirit the `decision.record` doctype declares (a lone
 *      bad decision never sinks the grounded ones).
 *   3. Two invariants are the RUNNER'S to own, never the model's to assert: the
 *      `decisionId` (the runner mints identity), and `why.reconstructed` (the runner
 *      stamps the literal `true`, so an inferred rationale can never be presented as
 *      a stated fact — reconstructed-ness is structural). And there is NO triage
 *      taxonomy anywhere: no evidenced / mechanical / contestable bucket, no verdict.
 *      Grouping (the projector's job) + evidence + a reconstructed why is the whole
 *      shape; judging a decision is the reviewer's job.
 */

import {
  type AssembleOptions,
  assemblePrompt,
  DECISION_CONTRACT,
  type PromptContract,
  renderBaseInstruction,
  renderConventionLayer,
  renderHypothesisLayer,
} from "@rennet/instructions";
import type {
  BudgetGrant,
  ConventionCatalogue,
  DecisionEvidence,
  DecisionRecordBody,
  DecisionRecordElement,
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
} from "@rennet/protocol";
import { computeInputDigest, parseAnchor, resolveAnchor, validateDocument } from "@rennet/protocol";
import { absentBudgetGrant } from "./invocation-budget";

/** The result of one decision turn: the emitted body, or a turn-level failure. */
export type DecisionTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface DecisionProvenanceSeed {
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
 * The change's stated intent (issue #137). The runner reasons over the diff PLUS
 * this — the PR title/body and the spec when present — so it can discern the
 * implementer's decisions and the reasons behind them, not just what the code does.
 * Every field is optional: absent, the runner reasons over the diff alone (a
 * degraded but honest read). The full #136 frozen-immutable-snapshot intent capture
 * is DEFERRED; this is the live-intent seam the MVP fills.
 */
export interface DecisionIntent {
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly spec?: string;
}

export interface RunDecisionAngleInput {
  /** The patchset the offered manifest was built over; anchors resolve against it. */
  readonly patchsetId: string;
  /** The offered occurrence manifest: the hunk ids + lines the model may cite. */
  readonly manifest: OfferedManifest;
  /** The change's stated intent (PR title/body, spec); the runner reasons over it + the diff. */
  readonly intent?: DecisionIntent;
  /**
   * The committed hypothesis (#178). When present, it is rendered as a labelled
   * disconfirmation layer after the base instruction and before the payload, so
   * the runner can surface a decision where the change diverges from what we'd
   * have chosen. Absent, the runner assembles exactly as it does today.
   */
  readonly hypothesis?: ReviewHypothesis;
  /**
   * The per-project convention / anti-pattern catalogue (#180). When present with
   * at least one rule, it is rendered as a labelled checklist layer after the
   * hypothesis and before the general guidance — so the runner can surface a
   * decision where the change diverges from an established convention, reporting
   * the underlying REASON (never a rule number). Absent or empty, the runner
   * assembles exactly as it does today.
   */
  readonly conventions?: ConventionCatalogue;
  /** The `decision.record` contract; defaults to the shipped `DECISION_CONTRACT` (#137). */
  readonly contract?: PromptContract;
  readonly provenance: DecisionProvenanceSeed;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<DecisionTurnResult>;
  /** Optional repo guidance layers, wrapped as untrusted material by the assembler. */
  readonly guidance?: { readonly general?: string; readonly files?: string };
  readonly assembledContext?: string;
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, #95). Consulted before EVERY
   * turn — a turn over a CONFIGURED ceiling is refused; an ABSENT budget runs
   * UNGATED (#260: no budget means no ceiling, not no spend). A
   * refusal is terminal for this runner: no turn runs and the review resolves to
   * the honest `failed` state (never a fabricated decision). Optional only as a
   * test ergonomic; a real caller must thread one to run turns.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

export interface DecisionAttempt {
  readonly attempt: number;
  /**
   * `malformed-body`: the turn emitted, but the body was not a decision document
   * (not an object with a `decisions` array). It is recorded as its own fact —
   * distinct from `turn-failed` (the turn never emitted) and from an admitted
   * empty review — because a model that returned an unparseable shape has NOT
   * reviewed the code, and must never be reported as a clean, empty review (#158).
   */
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "malformed-body" | "budget-refused";
  /** The validation report for an attempt that produced a body; absent on a turn failure. */
  readonly report?: ValidationReport;
  readonly turnError?: string;
  /** The typed refusal when the budget refused this attempt at runtime (R10). */
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
  /** How many model-emitted decisions were dropped as ungrounded before the gate. */
  readonly culledCount?: number;
}

export interface RunDecisionAngleResult {
  /**
   * `ok` — the runner completed and produced a (possibly empty) grounded set of
   * decisions. `failed` — the runner did not complete (every turn failed, or the
   * budget refused). These map onto the Decisions lens's load-bearing distinction:
   * "ran, nothing discerned" is NEVER conflated with "did not run".
   */
  readonly status: "ok" | "failed";
  /** The admitted, grounded decisions (empty on `ok` when nothing survived the cull). */
  readonly decisions: DecisionRecordElement[];
  /** The emitted `decision.record` document, present when a turn produced an admitted body. */
  readonly document?: RspEnvelope;
  readonly report?: ValidationReport;
  readonly attempts: DecisionAttempt[];
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

const EVIDENCE_KINDS = new Set<DecisionEvidence["kind"]>(["spec", "pr-body", "hunk"]);

/** True iff a `rennet:` anchor parses AND resolves to an offered occurrence. */
function isGroundedAnchor(anchor: string, manifest: OfferedManifest): boolean {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return false;
  return resolveAnchor(parsed.anchor, manifest).outcome === "resolved";
}

/** True iff any string anywhere in `node` starts with the `rennet:` anchor prefix. */
function hasAnyAnchorString(node: unknown): boolean {
  if (typeof node === "string") return node.startsWith("rennet:");
  if (Array.isArray(node)) return node.some(hasAnyAnchorString);
  if (node !== null && typeof node === "object") {
    return Object.values(node as Record<string, unknown>).some(hasAnyAnchorString);
  }
  return false;
}

/**
 * Keep the model's well-formed evidence chips, each naming its SOURCE (spec /
 * pr-body / hunk) and the material it is drawn from — never a verdict. A chip with
 * a bad `kind`, a non-string label/detail, or a stray `rennet:` anchor smuggled
 * into its text is dropped. There is deliberately NO triage field: the shape is
 * `{ kind, label, detail }` and nothing else is carried.
 */
function cullEvidence(raw: unknown): DecisionEvidence[] {
  if (!Array.isArray(raw)) return [];
  const chips: DecisionEvidence[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const { kind, label, detail } = candidate;
    if (
      typeof kind !== "string" ||
      !EVIDENCE_KINDS.has(kind as DecisionEvidence["kind"]) ||
      typeof label !== "string" ||
      typeof detail !== "string" ||
      hasAnyAnchorString(label) ||
      hasAnyAnchorString(detail)
    ) {
      continue;
    }
    chips.push({ kind: kind as DecisionEvidence["kind"], label, detail });
  }
  return chips;
}

/** Keep only the model's non-empty, anchor-free alternative strings. */
function cullAlternatives(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0 && !item.startsWith("rennet:"),
  );
}

/**
 * The runner-owned reconstructed why: the model emits `{ text }`, and the runner
 * stamps `reconstructed: true` so an inferred rationale can NEVER be presented as a
 * stated fact. An absent, non-object, or empty-text why yields `undefined` — the
 * decision then renders on its title + evidence alone rather than an invented reason.
 */
function reconstructWhy(raw: unknown): DecisionRecordElement["why"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const text = (raw as Record<string, unknown>).text;
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  if (hasAnyAnchorString(text)) return undefined;
  return { reconstructed: true, text };
}

/**
 * The result of culling a model emission. `malformed` is the load-bearing
 * distinction: a body that is not a decision document (not an object with a
 * `decisions` array) is a fact APART from a well-formed body whose decisions
 * happen to be empty. A model that discerned nothing has reviewed the code; a
 * model that returned an unparseable shape has not — and only the first is a
 * clean review. Returning a discriminated union removes the ambiguity
 * STRUCTURALLY: the caller cannot read `decisions` off a malformed body, because
 * there is none to read (#158).
 */
type CullResult =
  | { readonly malformed: true }
  | {
      readonly malformed: false;
      readonly decisions: DecisionRecordElement[];
      readonly culled: number;
    };

/**
 * Cull the model's emitted decisions to the GROUNDED, well-formed ones and stamp
 * the runner-owned fields. A body that is not a decision document is reported as
 * `malformed` and NOT collapsed to an empty set (#158) — the caller routes it to
 * the failed path, never to a clean review. Otherwise, kept: a decision with a
 * string `anchor` that resolves to an offered hunk, a non-empty `title`, and no
 * stray `rennet:` anchor in any other field (which would reject the item at the
 * validator's generic walk). Dropped: anything else — never surfaced, so a lone
 * bad decision cannot sink the grounded ones. The `decisionId` is minted here
 * (agents never mint identity); the `why` is stamped `reconstructed: true`
 * (structural, not the model's to assert); evidence and alternatives are culled
 * to well-formed entries; and NO triage bucket or verdict is ever carried.
 */
function cullDecisions(
  body: unknown,
  manifest: OfferedManifest,
  mintDocId: () => string,
): CullResult {
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { decisions?: unknown }).decisions)
  ) {
    return { malformed: true };
  }
  const raw = (body as { decisions: unknown[] }).decisions;
  const decisions: DecisionRecordElement[] = [];
  let culled = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      culled += 1;
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const anchor = candidate.anchor;
    const title = candidate.title;
    if (
      typeof anchor !== "string" ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      !isGroundedAnchor(anchor, manifest)
    ) {
      culled += 1;
      continue;
    }
    const evidence = cullEvidence(candidate.evidence);
    const alternatives = cullAlternatives(candidate.alternatives);
    const why = reconstructWhy(candidate.why);
    // Belt-and-braces: a stray `rennet:` string smuggled into the title itself
    // would be checked by the validator's generic anchor walk and reject this
    // item, so cull it here to keep the built document's rejected-item count zero.
    if (hasAnyAnchorString(title)) {
      culled += 1;
      continue;
    }
    decisions.push({
      decisionId: mintDocId(),
      anchor,
      title,
      evidence,
      alternatives,
      ...(why ? { why } : {}),
    });
  }
  return { malformed: false, decisions, culled };
}

function buildProvenance(
  seed: DecisionProvenanceSeed,
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
  body: DecisionRecordBody,
  patchsetId: string,
  provenance: RspProvenance,
  docId: string,
): RspEnvelope {
  return {
    rsp: 1,
    docType: "decision.record",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
}

/** A compact, model-facing serialisation of the change's stated intent, when present. */
function renderIntent(intent: DecisionIntent | undefined): string | undefined {
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
  const itemErrors = report.rejectedItems.flatMap((rejected) =>
    rejected.errors.map((error) => `- ${error.code} at ${error.pointer}: ${error.message}`),
  );
  const lines = [
    ...report.errors.map((error) => `- ${error.code} at ${error.pointer}: ${error.message}`),
    ...itemErrors,
  ];
  return `The previous document was REJECTED. Fix every error and re-emit:\n${lines.join("\n")}`;
}

/**
 * Drive one decision angle to a validator-admitted `decision.record` document.
 * Assembles the contract prompt (the base instruction, the change's intent under
 * the task slot, and the offered hunks under the payload slot), runs the injected
 * turn, culls the emitted decisions to the grounded set, stamps a trustworthy
 * envelope, and validates. On a turn failure or an (unexpected) rejection it retries
 * with the report fed back — falling to the honest `failed` state on terminal
 * failure, never a fabricated decision.
 */
export async function runDecisionAngle(
  input: RunDecisionAngleInput,
): Promise<RunDecisionAngleResult> {
  const {
    patchsetId,
    manifest,
    intent,
    contract = DECISION_CONTRACT,
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

  const attempts: DecisionAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;
  let lastFailure = "the decision runner did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal for this runner and resolves to the honest failed
    // state (a decision is a judgement, so there is no floor to fall to).
    const purpose = `decision:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      attempts.push({ attempt, outcome: "budget-refused", budgetRefusal: grant });
      budgetRefused = true;
      lastFailure = grant.reason;
      break;
    }

    // The intent rides the `task` slot and the retry report is appended to it, so a
    // rejection's feedback never displaces the change's stated intent.
    const taskText = [intentText, lastReportText].filter((part) => part !== undefined).join("\n\n");
    const assembled = assemblePrompt(
      {
        base,
        ...(hypothesisLayer === undefined ? {} : { hypothesis: hypothesisLayer }),
        ...(conventionLayer === undefined ? {} : { conventions: conventionLayer }),
        ...(guidance?.general === undefined ? {} : { general: guidance.general }),
        ...(guidance?.files === undefined ? {} : { files: guidance.files }),
        ...(taskText.length === 0 ? {} : { task: taskText }),
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

    const cullResult = cullDecisions(turn.body, manifest, mintDocId);
    if (cullResult.malformed) {
      // A body that is not a decision document is NOT a clean review: the model
      // did not review the code, it returned an unparseable shape. Route it to
      // the failed path (retry, then the honest LOUD failed state) — never
      // `{ decisions: [] }`, which would report a review that ran clean (#158).
      attempts.push({
        attempt,
        outcome: "malformed-body",
        turnError: "the model emitted a body that is not a decision document",
      });
      lastFailure = "the model emitted a malformed decision body";
      continue;
    }
    const { decisions, culled } = cullResult;
    const body: DecisionRecordBody = { decisions };
    const provenance = buildProvenance(seed, inputDigest, newRunId(), turn.tokens ?? ZERO_TOKENS);
    const document = buildEnvelope(body, patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    // `decision.record` is item-wise, so an admitted document can still carry
    // rejected items. The runner culls to a set that should always admit WHOLE
    // (every item grounded, zero rejected); a nonzero rejected count is unexpected,
    // so feed the report back and retry rather than place a partially-admitted set.
    if (report.admitted && report.rejectedItemCount === 0) {
      attempts.push({ attempt, outcome: "admitted", report, culledCount: culled });
      return { status: "ok", decisions, document, report, attempts, budgetRefused };
    }
    attempts.push({ attempt, outcome: "rejected", report, culledCount: culled });
    lastReportText = renderReport(report);
    lastFailure = "the decision document was rejected by the validator";
  }

  // Terminal failure: no floor to invent. The lens renders the LOUD failed state.
  return {
    status: "failed",
    decisions: [],
    attempts,
    budgetRefused,
    failureReason: lastFailure,
  };
}
