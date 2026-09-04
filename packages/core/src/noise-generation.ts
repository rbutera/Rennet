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
import { computeInputDigest, validateDocument } from "@rennet/protocol";
import { type ChangedRegion, resolveCitation } from "./board/lint";
import { absentBudgetGrant } from "./invocation-budget";

/**
 * One context file, structurally identical to the server's `SessionContextFile` — this
 * package cannot import the server, and this is the whole contract.
 */
export interface NoiseContextFile {
  readonly name: string;
  readonly body: string;
  /** One line: what this file holds. */
  readonly holds: string;
  /** One line: when a turn should read it. */
  readonly readWhen: string;
}

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
  /**
   * The daemon's ONE session-context writer, bound to the seat's root and a session id
   * (session-context-files D3). It writes `noise-offer.json` and returns the context
   * directory AS THE SEAT SHOULD NAME IT (relative to its cwd, or absolute); the prompt
   * names that path and never carries the offer. Structural, because this package cannot
   * import the server that owns the writer.
   */
  readonly writeContext: (files: readonly NoiseContextFile[]) => string;
  /**
   * Rennet's assembled project context for this base. Copied ONCE into the session's
   * context directory and named there; it never rides a prompt, and it is never named at
   * the daemon's own store path, which a seat in another locus (WSL) cannot open.
   */
  readonly assembledContext?: string;
  /** The `git diff` that shows the seat the whole change from its cwd (`reviewedDiffCommand`). */
  readonly diffCommand?: string;
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

/**
 * The offered hunks as CHANGED REGIONS, plus which hunk each region came from.
 *
 * This is the whole of path-line-citations on this leg: the offer the model reads is a
 * list of regions with no ids in it, the model cites a region, and the runner reads the
 * hunk id back off this map. A hunk contributes a region per side it actually changed —
 * a pure addition has no base-side lines to cite, so it offers none.
 */
interface OfferedRegions {
  readonly regions: readonly ChangedRegion[];
  readonly hunkOf: ReadonlyMap<ChangedRegion, string>;
}

export function offeredRegions(manifest: OfferedManifest): OfferedRegions {
  const regions: ChangedRegion[] = [];
  const hunkOf = new Map<ChangedRegion, string>();
  for (const occurrence of manifest.occurrences) {
    if (occurrence.kind !== "hunk") continue;
    const { path, spans } = occurrence;
    if (path === undefined || spans === undefined) continue;
    for (const [side, span] of [
      ["base", spans.old],
      ["head", spans.new],
    ] as const) {
      if (span.lines < 1) continue;
      const region: ChangedRegion = {
        path,
        side,
        start: span.start,
        end: span.start + span.lines - 1,
      };
      regions.push(region);
      hunkOf.set(region, occurrence.id);
    }
  }
  return { regions, hunkOf };
}

/**
 * The hunk a cited region belongs to, or `undefined` when the citation grounds in none.
 *
 * `resolveCitation` is the shared readability predicate (the board's
 * `unresolvable-citation` rule and the daemon's reader use the same one), so a citation
 * that names lines outside the change is refused here on exactly the terms it is refused
 * everywhere else. Containment is then required on top of it: a span that runs across two
 * offered hunks resolves to the first, and anchoring it to that one would silently claim
 * churn the item never cited.
 */
function hunkForCitation(span: ChangedRegion, offered: OfferedRegions): string | undefined {
  const region = resolveCitation(span, offered.regions);
  if (region === undefined) return undefined;
  if (span.start < region.start || span.end > region.end) return undefined;
  return offered.hunkOf.get(region);
}

/** Read an emitted item's citation, or `undefined` if it is not a well-formed one. */
function readItemCitation(candidate: Record<string, unknown>): ChangedRegion | undefined {
  const { path, side, startLine, endLine } = candidate;
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (side !== "base" && side !== "head") return undefined;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return undefined;
  const start = startLine as number;
  const end = endLine as number;
  if (start < 1 || end < start) return undefined;
  return { path, side, start, end };
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
 * Keep the group's well-formed, GROUNDED churn items, MINTING each one's anchor.
 *
 * An item survives iff its `path`/`side`/`startLine`/`endLine` citation resolves inside
 * one offered hunk, its `detail` is a string carrying no stray `rennet:` anchor (which the
 * generic walk would ground and reject), and its `deviates` flag (when present) is a
 * boolean. A `deviates: true` item is KEPT with its flag — the derivation ejects it into
 * normal review; the runner never suppresses it. Anything else is dropped.
 *
 * The surviving item carries BOTH the coordinates the model gave and the
 * `rennet:hunk/<id>` anchor the runner minted from them. The anchor is what the delta
 * validator's generic walk grounds and what the lens resolves; the coordinates are what
 * keeps the stored document satisfying the model-facing body shape on the V108 re-check.
 * No id reached the model in either direction.
 */
function cullItems(raw: unknown, offered: OfferedRegions): NoiseItem[] {
  if (!Array.isArray(raw)) return [];
  const items: NoiseItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const { detail, deviates } = candidate;
    if (
      typeof detail !== "string" ||
      hasAnyAnchorString(detail) ||
      (deviates !== undefined && typeof deviates !== "boolean")
    ) {
      continue;
    }
    const citation = readItemCitation(candidate);
    if (citation === undefined) continue;
    const hunkId = hunkForCitation(citation, offered);
    if (hunkId === undefined) continue;
    items.push({
      anchor: `rennet:hunk/${hunkId}`,
      path: citation.path,
      side: citation.side,
      startLine: citation.start,
      endLine: citation.end,
      detail,
      ...(deviates === true ? { deviates: true } : {}),
    });
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
  offered: OfferedRegions,
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
    const items = cullItems(candidate.items, offered);
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

/** The offered manifest's file in the session's context directory. The prompt names it. */
export const NOISE_OFFER_FILE = "noise-offer.json";

/**
 * The offer as written to `noise-offer.json`: every changed region of the patchset as a
 * `path`, a `side` and a 1-based line range — NO line bodies, and NO ids (path-line-
 * citations: a hunk id is an internal key and never reaches a model, in either
 * direction). The seat's cwd is the reviewed checkout, so it reads the lines it is
 * grouping from `git diff` like every other seat, and nothing about the change's size
 * reaches the prompt. This replaces the 256 KiB inline payload that rode every attempt
 * (#737) and had to count what it dropped; a file has nothing to drop. Compact JSON: an
 * indent is a surcharge no reader sees.
 */
export function renderNoiseOffer(manifest: OfferedManifest, patchsetId: string): string {
  return JSON.stringify({
    patchsetId,
    regions: offeredRegions(manifest).regions.map((region) => ({
      path: region.path,
      side: region.side,
      startLine: region.start,
      endLine: region.end,
    })),
  });
}

/**
 * The payload layer: a path reference to the offer (angle-prompt-contract — the layer
 * that used to BE the offer now names it) plus the diff command that shows the lines.
 * Its size does not depend on the change.
 */
export function renderNoiseOfferLayer(input: {
  readonly contextDir: string;
  readonly diffCommand?: string;
}): string {
  const offerPath = `${input.contextDir.replace(/\/$/, "")}/${NOISE_OFFER_FILE}`;
  return [
    "Your working directory is a checkout of the reviewed repository.",
    `The changed regions you may cite are listed in \`${offerPath}\`: each entry is a \`path\`, a \`side\` (\`base\` or \`head\`) and a 1-based \`startLine\`/\`endLine\`. Read that file first.`,
    `Read the lines themselves from the checkout — ${
      input.diffCommand === undefined ? "`git diff`" : `\`${input.diffCommand}\``
    } shows the whole change — and group only churn whose lines you actually read.`,
  ].join("\n");
}

/** Rennet's assembled project context, copied into the session's context directory. */
export const NOISE_PROJECT_CONTEXT_FILE = "project-context.md";

/**
 * The context layer: the assembled project context, named RELATIVE to the seat's cwd.
 *
 * It used to name the daemon's own absolute store path
 * (`~/.rennet/projects/<key>/context-manifests/<base>.context.txt`). A seat does not run
 * in the daemon's locus — a WSL seat is launched with `wsl.exe --cd <distro root>` — so
 * that path named a file it could not open. The text is copied into the session context
 * directory instead, beside every other file the turn is told about.
 */
export function renderNoiseAssembledContextLayer(contextDir: string): string {
  return `Rennet's assembled project context for this base is at \`${contextDir.replace(/\/$/, "")}/${NOISE_PROJECT_CONTEXT_FILE}\`; read it when a group's reason turns on a repository convention.`;
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
  // Built once: the regions the offer file shows the model, and the hunk each one maps
  // back to when an emitted citation is turned into an anchor.
  const offered = offeredRegions(manifest);
  const base = renderBaseInstruction(contract);
  // The offer is written ONCE, before any turn, and named on every attempt. There is no
  // payload layer any more, so a retry re-sends nothing of the change: the base, the
  // path references, and the validator's pointers.
  const contextDir = input.writeContext([
    {
      name: NOISE_OFFER_FILE,
      body: renderNoiseOffer(manifest, patchsetId),
      holds:
        "The changed regions you may cite: each one's path, side and 1-based line range, no line bodies.",
      readWhen: "first, before you read the change; cite only lines inside a region listed here.",
    },
    ...(input.assembledContext === undefined
      ? []
      : [
          {
            name: NOISE_PROJECT_CONTEXT_FILE,
            body: input.assembledContext,
            holds: "Rennet's assembled project context for this base.",
            readWhen: "when a group's reason turns on a repository convention.",
          },
        ]),
  ]);
  const offerLayer = renderNoiseOfferLayer({
    contextDir,
    ...(input.diffCommand === undefined ? {} : { diffCommand: input.diffCommand }),
  });
  const contextLayer =
    input.assembledContext === undefined ? undefined : renderNoiseAssembledContextLayer(contextDir);
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
        ...(contextLayer === undefined ? {} : { context: contextLayer }),
        payload: offerLayer,
      },
      assembleOptions ?? {},
    );

    const turn = await runTurn(assembled.text, attempt);
    if (turn.status === "failed") {
      attempts.push({ attempt, outcome: "turn-failed", turnError: turn.message });
      lastFailure = turn.message;
      continue;
    }

    const cullResult = cullGroups(turn.body, offered, noiseJobModel, mintDocId);
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
