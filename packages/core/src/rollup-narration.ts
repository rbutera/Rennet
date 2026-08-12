/**
 * Roll-up narration (issue #70, Model Council job M22).
 *
 * The zoom ladder's own voice. #10 gives the layered canvases; #11 renders their
 * zoom levels (rollup → cohort → element → diff). But every altitude ABOVE a
 * single chunk shows STRUCTURE without MEANING: a cohort header names its chunk,
 * the rollup counts its parts, and neither ACCOUNTS for itself. The product
 * thesis is zoom — "approve at ANY granularity" (P&V §3) — and an approval at the
 * cohort level is only an INFORMED act if the cohort can say what it is. This
 * module produces that account: a light-tier, batched, council-routed model job
 * emitting one one-line + one-paragraph account per node above a chunk.
 *
 * It reuses the ordering pass's infrastructure verbatim (the seven-slot contract,
 * the RSP validator, the report-fed retry loop, the shared invocation budget) and
 * follows its two settled properties:
 *
 *   - The RUNNER mints the docId and stamps the inputDigest, so "agents never mint
 *     identity" is structural.
 *   - The validator cannot see the canvas-node set (its manifest offers CODE
 *     occurrences, so quotes byte-verify — V006), so this pass enforces node
 *     coverage itself: every offered node narrated exactly once, only offered
 *     nodes, altitude consistent. A violation is fail-closed and fed back on
 *     retry, exactly as `runOrderingPass` enforces its dependency floor.
 *
 * The ONE difference from ordering: narration has NO deterministic fallback (you
 * cannot deterministically write prose). So on terminal failure there is no
 * fabricated document — the pass returns an HONEST `pending`/`failed` outcome and
 * the placement renders the never-blank state (the acceptance floor). A fabricated
 * account is never preferable to an honest "narration pending".
 */

import {
  type AssembleOptions,
  assemblePrompt,
  type PromptContract,
  renderBaseInstruction,
} from "@rennet/instructions";
import { computeInputDigest, validateDocument } from "@rennet/protocol";
import type {
  BudgetGrant,
  Canvas,
  CanvasAngle,
  Decomposition,
  InvocationBudget,
  NarrationAltitude,
  NarrationEntry,
  OfferedManifest,
  ResolutionTrace,
  ReviewNarration,
  RollupNarrationBody,
  RspCapabilitySnapshot,
  RspEnvelope,
  RspModelReportedBy,
  RspProvenance,
  RspTokenUsage,
  ValidationError,
  ValidationReport,
} from "@rennet/types";
import { buildOfferedManifest } from "./angle-generation";
import type { HarnessTurnResult } from "./harness-run-turn";
import { absentBudgetGrant } from "./invocation-budget";

/** The stable node key of the whole-changeset roll-up altitude. */
export const ROLLUP_NARRATION_ANCHOR = "rollup";

export const NARRATION_CHUNK_EXCERPT_MAX_BYTES = 12_288;
export const NARRATION_SINGLE_CHUNK_MAX_BYTES = 2_048;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// ── The offered node set (pure) ──────────────────────────────────────────────

/**
 * One canvas node the narration accounts for: the whole-changeset roll-up, a
 * group, or a cohort. `anchor` is the node key the narration entry references
 * (the rollup key, or a cohortKey); `title` and `elementTitles` are the context
 * the model narrates from. Plain node keys — never `rennet:` code anchors.
 */
export interface NarrationNode {
  readonly altitude: NarrationAltitude;
  readonly anchor: string;
  readonly title: string;
  readonly elementTitles: string[];
}

/**
 * The nodes above a single chunk that are VISIBLE on a canvas and therefore need a
 * voice: the whole-changeset roll-up (always present, one per review) plus every
 * cohort across the canvas set (deduped by node key — a cohortKey is unique to its
 * chunk). Deterministic and pure. The `group` altitude is reserved in the schema
 * for a future grouping level; the canvas model has no group nodes today, so none
 * are offered — an honest empty rather than an invented level.
 */
export function offeredNarrationNodes(canvases: Record<CanvasAngle, Canvas>): NarrationNode[] {
  const nodes: NarrationNode[] = [];

  // The roll-up node: the whole change. Its context is every cohort's title, so
  // the model can frame the whole from its parts.
  const cohortTitles: string[] = [];
  const seen = new Set<string>();
  const cohortNodes: NarrationNode[] = [];

  for (const canvas of Object.values(canvases)) {
    const elementTitle = new Map<string, string>();
    for (const element of canvas.layers.analysis.elements) {
      elementTitle.set(element.elementKey, element.title);
    }
    for (const cohort of canvas.layers.analysis.cohorts) {
      if (seen.has(cohort.cohortKey)) continue;
      seen.add(cohort.cohortKey);
      cohortTitles.push(cohort.title);
      cohortNodes.push({
        altitude: "cohort",
        anchor: cohort.cohortKey,
        title: cohort.title,
        elementTitles: cohort.elementKeys.map((key) => elementTitle.get(key) ?? key),
      });
    }
  }

  nodes.push({
    altitude: "rollup",
    anchor: ROLLUP_NARRATION_ANCHOR,
    title: "The whole change",
    elementTitles: cohortTitles,
  });
  nodes.push(...cohortNodes);
  return nodes;
}

// ── The orchestration ────────────────────────────────────────────────────────

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface NarrationProvenanceSeed {
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

export interface RunRollupNarrationInput {
  /** The nodes above a chunk to narrate — from `offeredNarrationNodes`. */
  readonly nodes: NarrationNode[];
  /** The decomposition, for the CODE manifest (quote byte-verify + inputDigest). */
  readonly decomposition: Decomposition;
  readonly patchsetId: string;
  /** The `rollup-narration` contract (from `@rennet/instructions`). */
  readonly contract: PromptContract;
  readonly provenance: NarrationProvenanceSeed;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  readonly guidance?: { readonly general?: string; readonly files?: string };
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The SHARED live invocation budget (issue #69, bead p0wwp). Consulted before
   * EVERY turn; a refusal is fail-closed and terminal — narration falls to the
   * honest pending/failed state, never a fabricated account. When one budget is
   * threaded through decomposition, ordering AND narration, the whole model phase
   * draws from a single ceiling: narration's turns count toward the <5 ceiling.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

/** narration `narrated` (admitted) / `pending` (no turn ran) / `failed` (ran, rejected). */
export type NarrationOutcome = "narrated" | "pending" | "failed";

export interface NarrationAttempt {
  readonly attempt: number;
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "budget-refused";
  readonly report?: ValidationReport;
  readonly turnError?: string;
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
}

export interface RunRollupNarrationResult {
  readonly outcome: NarrationOutcome;
  /** The admitted document, present iff `outcome === "narrated"`. */
  readonly document?: RspEnvelope;
  readonly report?: ValidationReport;
  readonly attempts: NarrationAttempt[];
  readonly offeredNodes: NarrationNode[];
  /** True when the live invocation budget refused a turn at runtime (R10 ceiling hit). */
  readonly budgetRefused: boolean;
  /** Node key → the admitted account; populated iff `outcome === "narrated"`. */
  readonly narrations: Map<string, NarrationEntry>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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

interface NarrationChunkEvidence {
  readonly chunkId: string;
  readonly title: string;
  readonly filePaths: string[];
  readonly excerpt: string;
  readonly truncated: boolean;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = UTF8_ENCODER.encode(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    try {
      return { text: UTF8_DECODER.decode(encoded.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return {
    text: "",
    truncated: true,
  };
}

function renderHunkEvidence(hunk: Decomposition["hunks"][number]): string {
  const lines = [`hunk ${hunk.id} (${hunk.filePath})`];
  for (const line of hunk.addedLines) lines.push(`added: ${line}`);
  for (const line of hunk.deletedLines) lines.push(`deleted: ${line}`);
  for (const line of hunk.contextLines) lines.push(`context: ${line}`);
  return lines.join("\n");
}

export function buildNarrationChunkEvidence(
  decomposition: Decomposition,
): NarrationChunkEvidence[] {
  const chunksById = new Map(decomposition.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const orderedChunks = [
    ...decomposition.readingOrder
      .map((chunkId) => chunksById.get(chunkId))
      .filter((chunk): chunk is Decomposition["chunks"][number] => chunk !== undefined),
    ...decomposition.chunks.filter((chunk) => !decomposition.readingOrder.includes(chunk.chunkId)),
  ];
  const hunksById = new Map(decomposition.hunks.map((hunk) => [hunk.id, hunk]));
  const share = Math.min(
    NARRATION_SINGLE_CHUNK_MAX_BYTES,
    Math.floor(NARRATION_CHUNK_EXCERPT_MAX_BYTES / Math.max(1, orderedChunks.length)),
  );

  return orderedChunks.map((chunk) => {
    const complete = chunk.hunkIds
      .map((hunkId) => hunksById.get(hunkId))
      .filter((hunk): hunk is Decomposition["hunks"][number] => hunk !== undefined)
      .map(renderHunkEvidence)
      .join("\n\n");
    const excerpt = truncateUtf8(complete, share);
    return {
      chunkId: chunk.chunkId,
      title: chunk.title,
      filePaths: chunk.filePaths,
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
    };
  });
}

/** A compact, model-facing serialisation of the nodes and their code evidence. */
function renderPayload(
  nodes: NarrationNode[],
  decomposition: Decomposition,
  patchsetId: string,
): string {
  const rendered = nodes.map((node) => ({
    altitude: node.altitude,
    node: node.anchor,
    title: node.title,
    covers: node.elementTitles,
  }));
  return JSON.stringify(
    { patchsetId, nodes: rendered, chunks: buildNarrationChunkEvidence(decomposition) },
    null,
    2,
  );
}

/**
 * The pass-level node-coverage floor the validator cannot enforce (its manifest
 * offers CODE occurrences, not canvas nodes). For an admitted body: every offered
 * node is narrated exactly once, no narration references a node that was not
 * offered, and each entry's altitude matches its offered node's altitude. A
 * violation is fail-closed: the attempt is treated as rejected and fed back.
 */
function narrationCoverageViolations(body: unknown, nodes: NarrationNode[]): ValidationError[] {
  const offered = new Map<string, NarrationAltitude>();
  for (const node of nodes) offered.set(node.anchor, node.altitude);

  const narrations = (body as RollupNarrationBody).narrations;
  const errors: ValidationError[] = [];
  const counts = new Map<string, number>();

  narrations.forEach((entry, index) => {
    counts.set(entry.anchor, (counts.get(entry.anchor) ?? 0) + 1);
    const offeredAltitude = offered.get(entry.anchor);
    if (offeredAltitude === undefined) {
      errors.push({
        code: "NARRATION_MINTED_NODE",
        pointer: `/body/narrations/${index}/anchor`,
        message: `narration references a node not in the offered set (minted node): ${entry.anchor}`,
      });
    } else if (entry.altitude !== offeredAltitude) {
      errors.push({
        code: "NARRATION_ALTITUDE",
        pointer: `/body/narrations/${index}/altitude`,
        message: `narration altitude ${entry.altitude} does not match the offered node's altitude ${offeredAltitude} for ${entry.anchor}`,
      });
    }
  });

  for (const [anchor, count] of counts) {
    if (count > 1 && offered.has(anchor)) {
      errors.push({
        code: "NARRATION_COVERAGE",
        pointer: "/body/narrations",
        message: `node is narrated more than once: ${anchor}`,
      });
    }
  }
  for (const anchor of offered.keys()) {
    if (!counts.has(anchor)) {
      errors.push({
        code: "NARRATION_COVERAGE",
        pointer: "/body/narrations",
        message: `offered node is missing a narration (not totally covered): ${anchor}`,
      });
    }
  }
  return errors;
}

/** Format a validation report into the machine-readable text fed back on retry. */
function renderReport(report: ValidationReport): string {
  const lines = report.errors.map(
    (error) => `- ${error.code} at ${error.pointer}: ${error.message}`,
  );
  return `The previous document was REJECTED. Fix every error and re-emit:\n${lines.join("\n")}`;
}

function buildProvenance(
  seed: NarrationProvenanceSeed,
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
    // Narration is a LIGHT-tier job (council row 6); the route is agentic/utility.
    tier: "light",
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
  body: unknown,
  patchsetId: string,
  provenance: RspProvenance,
  docId: string,
): RspEnvelope {
  return {
    rsp: 1,
    docType: "rollup-narration",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
}

/** Index an admitted body's narrations by node key (coverage floor guarantees 1:1). */
function narrationsByAnchor(body: unknown): Map<string, NarrationEntry> {
  const map = new Map<string, NarrationEntry>();
  for (const entry of (body as RollupNarrationBody).narrations) map.set(entry.anchor, entry);
  return map;
}

/**
 * Drive the roll-up narration pass to a validator-admitted `rollup-narration`
 * document. Assembles the contract prompt over the offered nodes, runs the
 * injected turn, stamps a trustworthy envelope, validates (shape + prose + quote
 * byte-verify), enforces the node-coverage floor, and on rejection retries with
 * the report fed back. On terminal failure there is NO fabricated fallback: the
 * result carries the honest `pending`/`failed` outcome and the placement renders
 * the never-blank state.
 */
export async function runRollupNarration(
  input: RunRollupNarrationInput,
): Promise<RunRollupNarrationResult> {
  const {
    nodes,
    decomposition,
    patchsetId,
    contract,
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
  // The CODE manifest: hunk occurrences with text, so any `{anchor, quote}`
  // citation in a narration byte-verifies (V006). The narration node keys are
  // NOT in this manifest and are NOT `rennet:` anchors, so the code-anchor walk
  // ignores them (their coverage is this pass's floor, above).
  const manifest: OfferedManifest = buildOfferedManifest(decomposition);
  const inputDigest = computeInputDigest(patchsetRef, manifest);
  const base = renderBaseInstruction(contract);
  const payload = renderPayload(nodes, decomposition, patchsetId);

  const attempts: NarrationAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;
  let anyTurnRan = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal — fall to the honest never-blank state.
    const purpose = `narration:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      attempts.push({ attempt, outcome: "budget-refused", budgetRefusal: grant });
      budgetRefused = true;
      break;
    }

    const assembled = assemblePrompt(
      {
        base,
        ...(guidance?.general === undefined ? {} : { general: guidance.general }),
        ...(guidance?.files === undefined ? {} : { files: guidance.files }),
        ...(lastReportText === undefined ? {} : { task: lastReportText }),
        payload,
      },
      assembleOptions ?? {},
    );

    anyTurnRan = true;
    const turn = await runTurn(assembled.text, attempt);
    if (turn.status === "failed") {
      attempts.push({ attempt, outcome: "turn-failed", turnError: turn.message });
      continue;
    }

    const provenance = buildProvenance(seed, inputDigest, newRunId(), turn.tokens ?? ZERO_TOKENS);
    const document = buildEnvelope(turn.body, patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    if (report.admitted) {
      // The document is well-formed and every quote byte-verified; now enforce the
      // node-coverage floor the validator cannot see. Clean → admitted.
      const coverageErrors = narrationCoverageViolations(turn.body, nodes);
      if (coverageErrors.length === 0) {
        attempts.push({ attempt, outcome: "admitted", report });
        return {
          outcome: "narrated",
          document,
          report,
          attempts,
          offeredNodes: nodes,
          budgetRefused,
          narrations: narrationsByAnchor(turn.body),
        };
      }
      const coverageReport: ValidationReport = {
        ...report,
        admitted: false,
        errors: coverageErrors,
      };
      attempts.push({ attempt, outcome: "rejected", report: coverageReport });
      lastReportText = renderReport(coverageReport);
      continue;
    }
    attempts.push({ attempt, outcome: "rejected", report });
    lastReportText = renderReport(report);
  }

  // Terminal failure. There is no deterministic narration fallback: the outcome is
  // HONEST — `pending` when no turn ever ran (budget refused first, or nothing to
  // spend), `failed` when a turn ran but never admitted.
  return {
    outcome: anyTurnRan ? "failed" : "pending",
    attempts,
    offeredNodes: nodes,
    budgetRefused,
    narrations: new Map(),
  };
}

// ── Placement (delivered alongside the canvas set, like ElementDiffs #60) ──────

/**
 * Build the review's narration placement from the offered nodes and the run
 * result. Every offered node resolves to a placement — an admitted account, or an
 * HONEST `pending`/`failed` state, NEVER a silent blank (the acceptance floor).
 * When `result` is undefined the narration pass did not run (no executor, or the
 * route plan refused before any spend); every node is then `pending`.
 */
export function buildReviewNarration(
  nodes: NarrationNode[],
  result: RunRollupNarrationResult | undefined,
): ReviewNarration {
  const rollupNode = nodes.find((node) => node.altitude === "rollup");
  const cohortNodes = nodes.filter((node) => node.altitude === "cohort");

  const placementFor = (anchor: string): ReviewNarration["rollup"] => {
    if (result === undefined || result.outcome === "pending") return { status: "pending" };
    if (result.outcome === "failed") return { status: "failed" };
    const entry = result.narrations.get(anchor);
    // The coverage floor guarantees an entry for every offered node on a
    // `narrated` outcome; a missing one is impossible, but resolve it as `failed`
    // rather than a silent blank if the invariant is ever violated.
    if (entry === undefined) return { status: "failed" };
    return {
      status: "narrated",
      oneLine: entry.oneLine,
      paragraph: entry.paragraph,
      ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
    };
  };

  const cohorts: Record<string, ReviewNarration["rollup"]> = {};
  for (const node of cohortNodes) cohorts[node.anchor] = placementFor(node.anchor);

  return {
    rollup: rollupNode ? placementFor(rollupNode.anchor) : { status: "pending" },
    cohorts,
  };
}
