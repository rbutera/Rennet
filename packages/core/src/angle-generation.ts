/**
 * The diff-to-angles transformation for the decomposition angle (issue #8).
 *
 * Ties the three slice-1 pieces into one transformation: the offered manifest an
 * agent may cite (deterministic), the prompt contract that instructs it (from
 * `@rennet/instructions`), and the RSP validator that decides admission (from
 * `@rennet/protocol`). The agent emits ONLY the body, schema-constrained; this
 * module builds the trustworthy envelope around it — minting the `docId` and
 * stamping `provenance` including `inputDigest` — so "agents never mint identity"
 * is a structural property, not an instruction.
 *
 * On rejection the machine-readable report is fed back into the next attempt (up
 * to `maxRetries`, sharing the budget); on terminal failure the deterministic
 * floor stands (`deterministicProposalBody`), never a spinner over an empty
 * screen. Same-session multi-turn retry is deferred (slice-1 adapters are
 * single-turn); the retry seam here is a per-attempt `runTurn` the caller wires.
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
  ChunkAngle,
  Decomposition,
  DecompositionProposalBody,
  InvocationBudget,
  ManifestOccurrence,
  OfferedManifest,
  ProposalChunk,
  ResolutionTrace,
  RspCapabilitySnapshot,
  RspEnvelope,
  RspModelReportedBy,
  RspProvenance,
  RspTokenUsage,
  ValidationReport,
} from "@rennet/types";
import { absentBudgetGrant } from "./invocation-budget";

/**
 * The offered manifest for the decomposition angle: the SUBSTANTIVE hunks only.
 * Mechanical hunks are the deterministic noise floor's domain (verified checkers
 * are their only admission authority) and are never offered here, so the agent
 * can neither cite nor be asked to place them. This is the input `inputDigest` is
 * computed over.
 */
export function buildOfferedManifest(decomposition: Decomposition): OfferedManifest {
  const mechanical = new Set(
    decomposition.classifications
      .filter((classification) => classification.kind === "mechanical")
      .map((classification) => classification.hunkId),
  );
  const occurrences: ManifestOccurrence[] = decomposition.hunks
    .filter((hunk) => !mechanical.has(hunk.id))
    .map((hunk) => ({
      id: hunk.id,
      kind: "hunk",
      path: hunk.filePath,
      sides: {
        additions: hunk.addedLines,
        deletions: hunk.deletedLines,
        context: hunk.contextLines,
      },
    }));
  return { occurrences };
}

const DEFAULT_SEQUENCE_ANGLE: readonly ChunkAngle[] = ["sequence"];

/**
 * Project a floor decomposition into a valid `decomposition.proposal` body: the
 * substantive chunks (mechanical/appendix chunks belong to the noise angle), the
 * substantive dependency edges, a reading order restricted to those chunks, and
 * an empty residue (the floor places every substantive hunk). This is the
 * always-present offline fallback the deterministic floor stands on.
 */
export function deterministicProposalBody(decomposition: Decomposition): DecompositionProposalBody {
  const substantiveChunkIds = new Set(
    decomposition.chunks
      .filter((chunk) => chunk.kind === "substantive")
      .map((chunk) => chunk.chunkId),
  );

  const chunks: ProposalChunk[] = decomposition.chunks
    .filter((chunk) => chunk.kind === "substantive")
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      title: chunk.title,
      hunkIds: [...chunk.hunkIds],
      angles: [...DEFAULT_SEQUENCE_ANGLE],
      rationale: `Deterministic floor grouping: ${chunk.title}`,
    }));

  const edges = decomposition.edges.filter(
    (edge) => substantiveChunkIds.has(edge.from) && substantiveChunkIds.has(edge.to),
  );
  const readingOrder = decomposition.readingOrder.filter((id) => substantiveChunkIds.has(id));

  return { chunks, edges, readingOrder, residue: [] };
}

// ── The orchestration ────────────────────────────────────────────────────────

/** The result of one decomposition turn: the emitted body, or a turn-level failure. */
export type DecompositionTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface DecompositionProvenanceSeed {
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

export interface RunDecompositionAngleInput {
  readonly decomposition: Decomposition;
  /** The `decomposition.proposal` contract (from `@rennet/instructions`). */
  readonly contract: PromptContract;
  readonly manifest: OfferedManifest;
  readonly provenance: DecompositionProvenanceSeed;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<DecompositionTurnResult>;
  /** Optional repo guidance layers, wrapped as untrusted material by the assembler. */
  readonly guidance?: { readonly general?: string; readonly files?: string };
  readonly assembledContext?: string;
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, fixes bead p0wwp). Consulted
   * before EVERY turn — the first attempt and every retry — so retries decrement
   * the same budget and a turn over the ceiling is refused at runtime. A refusal
   * is recorded (a `budget-refused` attempt) and the runner falls to the
   * deterministic floor. An ABSENT budget runs UNGATED (#260): no budget means no
   * ceiling, not no spend, so a caller without one runs turns unmetered.
   * Optional only as a test ergonomic.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly now?: () => number;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

export interface DecompositionAttempt {
  readonly attempt: number;
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "budget-refused";
  /** The validation report for an attempt that produced a body; absent on a turn failure. */
  readonly report?: ValidationReport;
  readonly turnError?: string;
  /** The typed refusal when the budget refused this attempt at runtime (R10). */
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
}

export interface RunDecompositionAngleResult {
  readonly admitted: boolean;
  readonly usedFallback: boolean;
  readonly document: RspEnvelope;
  readonly report: ValidationReport;
  readonly attempts: DecompositionAttempt[];
  /** True when the live invocation budget refused a turn at runtime (R10 ceiling hit). */
  readonly budgetRefused: boolean;
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

/** A compact, model-facing serialisation of the offered input. */
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

function buildProvenance(
  seed: DecompositionProvenanceSeed,
  route: "agentic" | "deterministic",
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
    tier: route === "deterministic" ? "deterministic" : "heavy",
    route,
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
    docType: "decomposition.proposal",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
}

/**
 * Drive one decomposition angle to a validator-admitted `decomposition.proposal`.
 * Assembles the contract prompt, runs the injected turn, stamps a trustworthy
 * envelope around the emitted body, validates, and on rejection retries with the
 * report fed back — falling back to the deterministic floor on terminal failure.
 */
export async function runDecompositionAngle(
  input: RunDecompositionAngleInput,
): Promise<RunDecompositionAngleResult> {
  const {
    decomposition,
    contract,
    manifest,
    provenance: seed,
    runTurn,
    guidance,
    assembleOptions,
    maxRetries = 2,
    budget,
  } = input;
  const mintDocId = input.mintDocId ?? defaultMintDocId;
  const newRunId = input.newRunId ?? defaultRunId;

  const patchsetRef = { id: decomposition.patchsetId };
  const inputDigest = computeInputDigest(patchsetRef, manifest);
  const base = renderBaseInstruction(contract);
  const payload = renderPayload(manifest, decomposition.patchsetId);

  const attempts: DecompositionAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal for this runner — every further attempt would also be
    // refused — so we record it and break to the deterministic floor.
    const purpose = `decomposition:attempt-${attempt}`;
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
        ...(input.assembledContext === undefined ? {} : { context: input.assembledContext }),
        payload,
      },
      assembleOptions ?? {},
    );

    const turn = await runTurn(assembled.text, attempt);
    if (turn.status === "failed") {
      attempts.push({ attempt, outcome: "turn-failed", turnError: turn.message });
      continue;
    }

    const provenance = buildProvenance(
      seed,
      "agentic",
      inputDigest,
      newRunId(),
      turn.tokens ?? ZERO_TOKENS,
    );
    const document = buildEnvelope(turn.body, decomposition.patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    if (report.admitted) {
      attempts.push({ attempt, outcome: "admitted", report });
      return { admitted: true, usedFallback: false, document, report, attempts, budgetRefused };
    }
    attempts.push({ attempt, outcome: "rejected", report });
    lastReportText = renderReport(report);
  }

  // Terminal failure (rejected out, turn failed, or budget refused): the
  // deterministic floor stands, admitted, route recorded.
  const fallbackBody = deterministicProposalBody(decomposition);
  const provenance = buildProvenance(seed, "deterministic", inputDigest, newRunId(), ZERO_TOKENS);
  const document = buildEnvelope(fallbackBody, decomposition.patchsetId, provenance, mintDocId());
  const report = validateDocument({ document, patchset: patchsetRef, manifest });
  return {
    admitted: report.admitted,
    usedFallback: true,
    document,
    report,
    attempts,
    budgetRefused,
  };
}
