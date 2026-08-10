/**
 * The diff-to-noise-groups transformation for the Noise lens (issue #34).
 *
 * The Noise lens groups the low-signal churn a changeset touches — formatting,
 * lockfile regeneration, import reordering, generated output, fixture renames,
 * comment typos — AWAY from the code that needs eyes. Each group is collapsed under
 * a plain-speech one-line summary, tagged with HOW it was judged (a deterministic
 * mechanical RULE, or the LLM NOISE JOB), and is pull-back-able: nothing is silently
 * hidden, only grouped. The SURFACE already shipped (`buildNoiseIndex`, fixture-
 * backed); this is the LIVE runner that replaces the fixture: a real model reasons
 * over the offered hunks of the change and PRODUCES the `noise` document the lens
 * renders.
 *
 * It mirrors `runFindingAngle` (#32) and `runDecisionAngle` (#137): the offered
 * manifest an agent may cite (deterministic), the prompt contract that instructs it
 * (`NOISE_CONTRACT` from `@rennet/instructions`), and the RSP validator that decides
 * admission (from `@rennet/protocol`). The agent emits ONLY the body, schema-
 * constrained; this module builds the trustworthy envelope around it — minting the
 * `docId`, stamping `provenance` including `inputDigest` — so "agents never mint
 * identity" is structural, not instruction.
 *
 * Four things are load-bearing, all inherited from the finding runner because a
 * noise grouping, like a finding, is a MODEL JUDGEMENT rather than a partition of a
 * fixed set:
 *
 *   1. There is NO deterministic floor. A change's low-signal churn cannot be
 *      derived mechanically here (the full deterministic mechanical-rules engine is
 *      a DEFERRED follow-up — see the PR), so terminal failure resolves to an honest
 *      `failed` state — never a manufactured group. The Noise lens keeps "ran clean"
 *      (an admitted, possibly-empty set) strictly apart from "the runner did not
 *      complete" (`failed`), and this runner preserves that distinction.
 *   2. Groups and their items are culled to the GROUNDED, well-formed ones before
 *      the gate: an item whose anchor does not resolve to an offered hunk (a
 *      hallucinated location), a group with a bad category or an empty summary or a
 *      junk judged-by, or a group left with no grounded items, is dropped rather
 *      than allowed to reject the document. The TOTALITY FLOOR is preserved for what
 *      survives: a `deviates` item is kept with its flag (the derivation ejects it
 *      into normal review — the runner never suppresses it), and a group is never
 *      partially placed.
 *   3. Two fields are the RUNNER'S to own, never the model's to assert: the per-group
 *      `groupId` (the runner mints identity), and the `model` on a `noise-job` chip
 *      (the runner stamps which model ran, so the chip's provenance is structural).
 *      A `rule` chip's rule NAME is the model's classification (e.g. `lockfile`), so
 *      it is kept as emitted — that is the model saying "a mechanical certainty
 *      settles this", which the reviewer reads distinct from a `noise-job` call.
 *   4. The `noise` document is admitted WHOLE (atomic): the runner culls to a set
 *      that always admits, so a residual rejection is unexpected and retried; on
 *      terminal failure the lens renders the LOUD failed state.
 */

import {
  type AssembleOptions,
  assemblePrompt,
  NOISE_CONTRACT,
  type PromptContract,
  renderBaseInstruction,
  renderHypothesisLayer,
} from "@rennet/instructions";
import { computeInputDigest, parseAnchor, resolveAnchor, validateDocument } from "@rennet/protocol";
import type {
  BudgetGrant,
  InvocationBudget,
  NoiseBody,
  NoiseCategory,
  NoiseGroup,
  NoiseItem,
  NoiseJudgedBy,
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
import { budgetAbsentRefusal } from "./invocation-budget";

/** The result of one noise turn: the emitted body, or a turn-level failure. */
export type NoiseTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface NoiseProvenanceSeed {
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

export interface RunNoiseAngleInput {
  /** The patchset the offered manifest was built over; anchors resolve against it. */
  readonly patchsetId: string;
  /** The offered occurrence manifest: the hunk ids + lines the model may cite. */
  readonly manifest: OfferedManifest;
  /**
   * The committed hypothesis (#178). When present, it is rendered as a labelled
   * disconfirmation layer after the base instruction and before the payload.
   * Absent, the runner assembles exactly as it does today.
   */
  readonly hypothesis?: ReviewHypothesis;
  /** The `noise` contract; defaults to the shipped `NOISE_CONTRACT` (#34). */
  readonly contract?: PromptContract;
  readonly provenance: NoiseProvenanceSeed;
  /**
   * The model label stamped into every `noise-job` chip (the runner OWNS this — the
   * model never asserts which model judged the churn). Defaults to the provenance
   * model, so a real caller that threads a live model gets an honest chip.
   */
  readonly noiseJobModel?: string;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<NoiseTurnResult>;
  /** Optional repo guidance layers, wrapped as untrusted material by the assembler. */
  readonly guidance?: { readonly general?: string; readonly files?: string };
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, #95). Consulted before EVERY
   * turn — a turn over the ceiling, or an ABSENT budget, is refused fail-closed
   * (Rule 75, vital money circuit: a single fault fails toward LESS spend). A
   * refusal is terminal for this runner: no turn runs and the review resolves to
   * the honest `failed` state (never a fabricated group). Optional only as a test
   * ergonomic; a real caller must thread one to run turns.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

export interface NoiseAttempt {
  readonly attempt: number;
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "budget-refused";
  /** The validation report for an attempt that produced a body; absent on a turn failure. */
  readonly report?: ValidationReport;
  readonly turnError?: string;
  /** The typed refusal when the budget refused this attempt at runtime (R10). */
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
  /** How many model-emitted groups were dropped as malformed/ungrounded before the gate. */
  readonly culledCount?: number;
}

export interface RunNoiseAngleResult {
  /**
   * `ok` — the runner completed and produced a (possibly empty) grounded set of
   * noise groups. `failed` — the runner did not complete (every turn failed, or the
   * budget refused). These map onto the Noise lens's load-bearing distinction: "ran
   * clean" is NEVER conflated with "did not run".
   */
  readonly status: "ok" | "failed";
  /** The admitted, grounded groups (empty on `ok` when nothing survived the cull). */
  readonly groups: NoiseGroup[];
  /** The emitted `noise` document, present when a turn produced an admitted body. */
  readonly document?: RspEnvelope;
  readonly report?: ValidationReport;
  readonly attempts: NoiseAttempt[];
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

const NOISE_CATEGORIES = new Set<NoiseCategory>([
  "formatting",
  "lockfile",
  "import-order",
  "generated",
  "fixture-rename",
  "comment-typo",
  "other",
]);

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
 * Keep the group's well-formed, GROUNDED churn items. An item survives iff its
 * `anchor` resolves to an offered hunk, its `detail` is a string carrying no stray
 * `rennet:` anchor (which the generic walk would ground and reject), and its
 * `deviates` flag (when present) is a boolean. A `deviates: true` item is KEPT with
 * its flag — the derivation ejects it into normal review; the runner never
 * suppresses it. Anything else is dropped.
 */
function cullItems(raw: unknown, manifest: OfferedManifest): NoiseItem[] {
  if (!Array.isArray(raw)) return [];
  const items: NoiseItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const { anchor, detail, deviates } = candidate;
    if (
      typeof anchor !== "string" ||
      typeof detail !== "string" ||
      hasAnyAnchorString(detail) ||
      (deviates !== undefined && typeof deviates !== "boolean") ||
      !isGroundedAnchor(anchor, manifest)
    ) {
      continue;
    }
    items.push({ anchor, detail, ...(deviates === true ? { deviates: true } : {}) });
  }
  return items;
}

/**
 * The runner-owned judged-by chip. A `rule` chip keeps the model's non-empty rule
 * NAME (its classification — "a mechanical certainty settles this"); a `noise-job`
 * chip has its `model` STAMPED by the runner (never the model's to assert). Any
 * other shape — a bad kind, an empty rule — yields `undefined`, which drops the
 * group (a group we cannot say how it was judged is not a group we may collapse).
 */
function judgedByOf(raw: unknown, noiseJobModel: string): NoiseJudgedBy | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === "rule") {
    const rule = candidate.rule;
    if (typeof rule !== "string" || rule.trim().length === 0 || rule.startsWith("rennet:")) {
      return undefined;
    }
    return { kind: "rule", rule };
  }
  if (candidate.kind === "noise-job") {
    return { kind: "noise-job", model: noiseJobModel };
  }
  return undefined;
}

/**
 * Cull the model's emitted groups to the GROUNDED, well-formed ones and stamp the
 * runner-owned fields. Kept: a group with a category in the closed vocabulary, a
 * non-empty anchor-free summary, a well-formed judged-by, and at least one grounded
 * item. Dropped: anything else — never surfaced, so a lone malformed group cannot
 * sink the grounded ones. The `groupId` is minted here (agents never mint identity);
 * the `noise-job` chip's `model` is stamped (structural, not the model's to assert).
 */
function cullGroups(
  body: unknown,
  manifest: OfferedManifest,
  noiseJobModel: string,
  mintDocId: () => string,
): { groups: NoiseGroup[]; culled: number } {
  const raw =
    typeof body === "object" && body !== null && Array.isArray((body as NoiseBody).groups)
      ? (body as { groups: unknown[] }).groups
      : [];
  const groups: NoiseGroup[] = [];
  let culled = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      culled += 1;
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const category = candidate.category;
    const summary = candidate.summary;
    if (
      typeof category !== "string" ||
      !NOISE_CATEGORIES.has(category as NoiseCategory) ||
      typeof summary !== "string" ||
      summary.trim().length === 0 ||
      summary.startsWith("rennet:")
    ) {
      culled += 1;
      continue;
    }
    const judgedBy = judgedByOf(candidate.judgedBy, noiseJobModel);
    if (judgedBy === undefined) {
      culled += 1;
      continue;
    }
    const items = cullItems(candidate.items, manifest);
    if (items.length === 0) {
      // A group with no grounded churn to collapse is not a group.
      culled += 1;
      continue;
    }
    groups.push({
      groupId: mintDocId(),
      category: category as NoiseCategory,
      summary,
      judgedBy,
      items,
    });
  }
  return { groups, culled };
}

function buildProvenance(
  seed: NoiseProvenanceSeed,
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
  body: NoiseBody,
  patchsetId: string,
  provenance: RspProvenance,
  docId: string,
): RspEnvelope {
  return {
    rsp: 1,
    docType: "noise",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
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

/**
 * Drive one noise angle to a validator-admitted `noise` document. Assembles the
 * contract prompt, runs the injected turn, culls the emitted groups to the grounded
 * set (minting group ids, stamping the noise-job model, preserving deviating flags),
 * stamps a trustworthy envelope, and validates. On a turn failure or an (unexpected)
 * rejection it retries with the report fed back — falling to the honest `failed`
 * state on terminal failure, never a fabricated group.
 */
export async function runNoiseAngle(input: RunNoiseAngleInput): Promise<RunNoiseAngleResult> {
  const {
    patchsetId,
    manifest,
    contract = NOISE_CONTRACT,
    provenance: seed,
    runTurn,
    guidance,
    assembleOptions,
    maxRetries = 2,
    budget,
  } = input;
  const mintDocId = input.mintDocId ?? defaultMintDocId;
  const newRunId = input.newRunId ?? defaultRunId;
  const noiseJobModel = input.noiseJobModel ?? seed.model;

  const patchsetRef = { id: patchsetId };
  const inputDigest = computeInputDigest(patchsetRef, manifest);
  const base = renderBaseInstruction(contract);
  const payload = renderPayload(manifest, patchsetId);
  const hypothesisLayer =
    input.hypothesis === undefined ? undefined : renderHypothesisLayer(input.hypothesis);

  const attempts: NoiseAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;
  let lastFailure = "the noise runner did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, fail-closed #95): consult the shared budget before
    // spending a turn. An ABSENT budget is not authorization to spend — it is a
    // refusal, exactly like an exhausted one (Rule 75, vital money circuit). A
    // refusal is terminal for this runner and resolves to the honest failed state (a
    // noise grouping is a judgement, so there is no floor to fall to).
    const purpose = `noise:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? budgetAbsentRefusal(purpose);
    if (!grant.granted) {
      attempts.push({ attempt, outcome: "budget-refused", budgetRefusal: grant });
      budgetRefused = true;
      lastFailure = grant.reason;
      break;
    }

    const assembled = assemblePrompt(
      {
        base,
        ...(hypothesisLayer === undefined ? {} : { hypothesis: hypothesisLayer }),
        ...(guidance?.general === undefined ? {} : { general: guidance.general }),
        ...(guidance?.files === undefined ? {} : { files: guidance.files }),
        ...(lastReportText === undefined ? {} : { task: lastReportText }),
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

    const { groups, culled } = cullGroups(turn.body, manifest, noiseJobModel, mintDocId);
    const body: NoiseBody = { groups };
    const provenance = buildProvenance(seed, inputDigest, newRunId(), turn.tokens ?? ZERO_TOKENS);
    const document = buildEnvelope(body, patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    if (report.admitted) {
      attempts.push({ attempt, outcome: "admitted", report, culledCount: culled });
      return { status: "ok", groups, document, report, attempts, budgetRefused };
    }
    // The runner culls to a set that should always admit; a rejection here is
    // unexpected, so feed the report back and retry rather than surface a
    // partially-validated document as groups.
    attempts.push({ attempt, outcome: "rejected", report, culledCount: culled });
    lastReportText = renderReport(report);
    lastFailure = "the noise document was rejected by the validator";
  }

  // Terminal failure: no floor to invent. The lens renders the LOUD failed state.
  return {
    status: "failed",
    groups: [],
    attempts,
    budgetRefused,
    failureReason: lastFailure,
  };
}
