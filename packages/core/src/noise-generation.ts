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
 * (`NOISE_CONTRACT` from `@rennet/prompts`), and the RSP validator that decides
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
  renderConventionLayer,
  renderHypothesisLayer,
} from "@rennet/prompts";
import type {
  BudgetGrant,
  ConventionCatalogue,
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
} from "@rennet/protocol";
import { computeInputDigest, parseAnchor, resolveAnchor, validateDocument } from "@rennet/protocol";
import { absentBudgetGrant } from "./invocation-budget";

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
  /**
   * The per-project convention / anti-pattern catalogue (#180). When present with
   * at least one rule, it is rendered as a labelled checklist layer after the
   * hypothesis and before the general guidance. It is fed here for parity across
   * all three lenses (a repo convention can bear on what counts as noise, e.g. a
   * project that treats a generated file as reviewable). Absent or empty, the
   * runner assembles exactly as it does today.
   */
  readonly conventions?: ConventionCatalogue;
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
  readonly assembledContext?: string;
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, #95). Consulted before EVERY
   * turn — a turn over a CONFIGURED ceiling is refused; an ABSENT budget runs
   * UNGATED (#260: no budget means no ceiling, not no spend). A
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
  /**
   * `malformed-body`: the turn emitted, but the body was not a noise document (not
   * an object with a `groups` array). It is recorded as its own fact — distinct
   * from `turn-failed` (the turn never emitted) and from an admitted empty review —
   * because a model that returned an unparseable shape has NOT reviewed the churn,
   * and must never be reported as a clean, empty review (#158).
   */
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "malformed-body" | "budget-refused";
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
 * The result of culling a model emission. `malformed` is the load-bearing
 * distinction: a body that is not a noise document (not an object with a `groups`
 * array) is a fact APART from a well-formed body whose groups happen to be empty.
 * A model that grouped nothing has reviewed the churn; a model that returned an
 * unparseable shape has not — and only the first is a clean review. Returning a
 * discriminated union removes the ambiguity STRUCTURALLY: the caller cannot read
 * `groups` off a malformed body, because there is none to read (#158).
 */
type CullResult =
  | { readonly malformed: true }
  | { readonly malformed: false; readonly groups: NoiseGroup[]; readonly culled: number };

/**
 * Cull the model's emitted groups to the GROUNDED, well-formed ones and stamp the
 * runner-owned fields. A body that is not a noise document is reported as
 * `malformed` and NOT collapsed to an empty set (#158) — the caller routes it to
 * the failed path, never to a clean review. Otherwise, kept: a group with a
 * category in the closed vocabulary, a non-empty anchor-free summary, a well-formed
 * judged-by, and at least one grounded item. Dropped: anything else — never
 * surfaced, so a lone malformed group cannot sink the grounded ones. The `groupId`
 * is minted here (agents never mint identity); the `noise-job` chip's `model` is
 * stamped (structural, not the model's to assert).
 */
function cullGroups(
  body: unknown,
  manifest: OfferedManifest,
  noiseJobModel: string,
  mintDocId: () => string,
): CullResult {
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { groups?: unknown }).groups)
  ) {
    return { malformed: true };
  }
  const raw = (body as { groups: unknown[] }).groups;
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
  return { malformed: false, groups, culled };
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

/**
 * UTF-8 ceiling on the noise seat's WHOLE hunk payload text (#737). Whole hunks are
 * kept in offered order until the next one would cross it; the rest are COUNTED in
 * a marker (a hunk the seat was not shown cannot be grouped and falls through to
 * normal review). Same magnitude as the round-evidence manifest bound. The payload
 * is re-sent on every retry, so the bound is per attempt.
 */
export const NOISE_PAYLOAD_MAX_BYTES = 262_144;

const PAYLOAD_ENCODER = new TextEncoder();

function payloadBytes(value: unknown): number {
  return PAYLOAD_ENCODER.encode(JSON.stringify(value)).length;
}

const PAYLOAD_READ_WITH =
  "This many offered hunks, in offered order after the last one shown, did not fit the payload bound. You cannot classify what you were not shown; they fall through to normal review. Group only the hunks above.";

/**
 * A compact, model-facing serialisation of the offered hunks and their lines. The
 * WHOLE returned text is bounded by `maxBytes`: whole hunks are kept in offered order
 * until the next would cross the budget left after reserving the truncation marker,
 * which carries a COUNT of omitted hunks (never a list — a list is itself unbounded,
 * review of #739). Compact JSON: an indent is a ~30% surcharge no reader sees.
 */
export function renderPayload(
  manifest: OfferedManifest,
  patchsetId: string,
  maxBytes: number = NOISE_PAYLOAD_MAX_BYTES,
): string {
  const offered = manifest.occurrences
    .filter((occurrence) => occurrence.kind === "hunk")
    .map((occurrence) => ({
      id: occurrence.id,
      additions: occurrence.sides?.additions ?? [],
      deletions: occurrence.sides?.deletions ?? [],
      context: occurrence.sides?.context ?? [],
    }));
  const marker = (omittedHunks: number) => ({ omittedHunks, readWith: PAYLOAD_READ_WITH });
  // Reserve the marker at its largest (every hunk omitted) so the kept set never has to
  // shrink again once the marker turns out to be needed.
  const envelopeBytes = payloadBytes({ patchsetId, hunks: [] });
  const markerOverhead =
    payloadBytes({ patchsetId, hunks: [], truncated: marker(offered.length) }) - envelopeBytes;
  const kept: typeof offered = [];
  let bytes = envelopeBytes;
  for (const hunk of offered) {
    const hunkBytes = payloadBytes(hunk) + (kept.length > 0 ? 1 : 0);
    if (bytes + hunkBytes + markerOverhead > maxBytes) break;
    kept.push(hunk);
    bytes += hunkBytes;
  }
  const omitted = offered.length - kept.length;
  return JSON.stringify(
    omitted === 0
      ? { patchsetId, hunks: kept }
      : { patchsetId, hunks: kept, truncated: marker(omitted) },
  );
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
  // The per-project convention checklist (#180). An absent catalogue, or one with
  // no rules, yields no layer — the assembled prompt is byte-identical to today.
  const conventionLayer =
    input.conventions === undefined || input.conventions.rules.length === 0
      ? undefined
      : renderConventionLayer(input.conventions);

  const attempts: NoiseAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;
  let lastFailure = "the noise runner did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal for this runner and resolves to the honest failed state (a
    // noise grouping is a judgement, so there is no floor to fall to).
    const purpose = `noise:attempt-${attempt}`;
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
        ...(hypothesisLayer === undefined ? {} : { hypothesis: hypothesisLayer }),
        ...(conventionLayer === undefined ? {} : { conventions: conventionLayer }),
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

    const cullResult = cullGroups(turn.body, manifest, noiseJobModel, mintDocId);
    if (cullResult.malformed) {
      // A body that is not a noise document is NOT a clean review: the model did
      // not review the churn, it returned an unparseable shape. Route it to the
      // failed path (retry, then the honest LOUD failed state) — never
      // `{ groups: [] }`, which would report a review that ran clean (#158).
      attempts.push({
        attempt,
        outcome: "malformed-body",
        turnError: "the model emitted a body that is not a noise document",
      });
      lastFailure = "the model emitted a malformed noise body";
      continue;
    }
    const { groups, culled } = cullResult;
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
