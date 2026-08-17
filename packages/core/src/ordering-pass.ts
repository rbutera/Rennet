/**
 * The comprehension-ordering pass (issue #9).
 *
 * Ordering is the product: the whole value of Rennet over "read the changed
 * files top-down on GitHub" is the reading order. #7 gives the deterministic
 * dependency-DAG baseline; #8 gives the admitted decomposition (the chunk set
 * plus its graph). This module asks an agent whether that baseline is the
 * clearest way to understand the change or whether a better high-level-then-
 * ground-up structure exists, and lets the agent PRODUCE the final reading order
 * as a validator-admitted `ordering` document.
 *
 * Two properties are load-bearing and settled: the user does NOT approve the
 * ordering (it is an agent-owned comprehension task — there is deliberately no
 * approval command), and the deterministic baseline remains the fallback
 * whenever the agent order is rejected or absent (the floor doctrine). The order
 * is LOGICAL, never danger/blast-radius/salience.
 *
 * This reuses #8's generation infrastructure verbatim: the seven-slot contract
 * (`ORDERING_CONTRACT`), the RSP validator, the report-fed retry loop, and the
 * always-present deterministic floor. As in #8, the pass mints the docId and
 * stamps the inputDigest, so "agents never mint identity" is structural.
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
  DecompositionEdge,
  DecompositionProposalBody,
  InvocationBudget,
  ManifestOccurrence,
  OfferedManifest,
  OrderingBody,
  ResolutionTrace,
  RspCapabilitySnapshot,
  RspEnvelope,
  RspModelReportedBy,
  RspProvenance,
  RspRoute,
  RspTokenUsage,
  ValidationError,
  ValidationReport,
} from "@rennet/types";
import type { TurnExecutorFacts } from "./harness-run-turn";
import { absentBudgetGrant } from "./invocation-budget";

/**
 * The offered manifest for the ordering pass: the chunk ids the admitted
 * decomposition declared. These are the only ids the agent may reference, and
 * the totality/no-minted rules (V111/V112) are checked against exactly this set.
 */
export function buildChunkManifest(proposal: DecompositionProposalBody): OfferedManifest {
  const occurrences: ManifestOccurrence[] = proposal.chunks.map((chunk) => ({
    id: chunk.chunkId,
    kind: "chunk",
  }));
  return { occurrences };
}

/**
 * Project the decomposition's baseline reading order into a valid `ordering`
 * body: the same order, admitted, with a rationale naming it as the baseline.
 * Because the admitted decomposition's `readingOrder` covers its chunks exactly
 * once (validator rule V103), this always covers the offered chunk set and
 * always validates. This is the always-present offline fallback.
 */
export function deterministicOrderingBody(proposal: DecompositionProposalBody): OrderingBody {
  return {
    readingOrder: [...proposal.readingOrder],
    rationale:
      "Deterministic dependency baseline order: no comprehension re-ordering was applied (the agent order was absent or rejected).",
  };
}

// ── The orchestration ────────────────────────────────────────────────────────

/** The result of one ordering turn: the emitted body, or a turn-level failure. */
export type OrderingTurnResult =
  | {
      readonly status: "emitted";
      readonly body: unknown;
      readonly tokens?: RspTokenUsage;
      /** Executor provenance facts, when the executor reported them (#88). */
      readonly executor?: TurnExecutorFacts;
    }
  | { readonly status: "failed"; readonly message: string };

/** The provenance a caller knows before the run; the rest is stamped per attempt. */
export interface OrderingProvenanceSeed {
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

export interface RunOrderingPassInput {
  /** The admitted decomposition: its chunk set and its baseline reading order. */
  readonly proposal: DecompositionProposalBody;
  readonly patchsetId: string;
  /** The `ordering` contract (from `@rennet/instructions`). */
  readonly contract: PromptContract;
  readonly provenance: OrderingProvenanceSeed;
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<OrderingTurnResult>;
  /** Optional repo guidance layers, wrapped as untrusted material by the assembler. */
  readonly guidance?: { readonly general?: string; readonly files?: string };
  readonly assembledContext?: string;
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  /**
   * The shared live invocation budget (issue #69, fixes bead p0wwp). Same
   * semantics as the decomposition runner: consulted before EVERY turn; a
   * refusal is fail-closed and falls to the deterministic baseline. When one
   * budget is threaded through both runners, the whole decomposition-plus-
   * ordering phase draws from a single ceiling.
   */
  readonly budget?: InvocationBudget;
  readonly assembleOptions?: AssembleOptions;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

export interface OrderingAttempt {
  readonly attempt: number;
  readonly outcome: "admitted" | "rejected" | "turn-failed" | "budget-refused";
  /** The validation report for an attempt that produced a body; absent on a turn failure. */
  readonly report?: ValidationReport;
  readonly turnError?: string;
  /** The typed refusal when the budget refused this attempt at runtime (R10). */
  readonly budgetRefusal?: Extract<BudgetGrant, { granted: false }>;
}

export interface RunOrderingPassResult {
  readonly admitted: boolean;
  readonly usedFallback: boolean;
  readonly document: RspEnvelope;
  readonly report: ValidationReport;
  readonly attempts: OrderingAttempt[];
  /** The deterministic baseline order, always exposed so a consumer can switch. */
  readonly baselineOrder: string[];
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

/** A compact, model-facing serialisation of the chunk set, the dependency edges
 *  (the hard floor), and the baseline order the agent is asked to improve on.
 *
 *  Deliberately omits each chunk's `angles`: the angle set includes
 *  `blast-radius`, and correction 8 forbids danger/blast-radius/salience as an
 *  ordering signal. The prohibition lives in the ORDERING_CONTRACT slot, but the
 *  cleanest guarantee is to never place the forbidden token in the ordering
 *  prompt at all. The chunk id, title, edges, and baseline carry the task. */
function renderPayload(proposal: DecompositionProposalBody, patchsetId: string): string {
  const chunks = proposal.chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    title: chunk.title,
  }));
  return JSON.stringify(
    { patchsetId, chunks, edges: proposal.edges, baselineOrder: proposal.readingOrder },
    null,
    2,
  );
}

/**
 * The pass-level hard-dependency floor. The RSP validator admits the ordering
 * document's cover/identity/rationale but cannot see the decomposition's edges
 * (they are not in the manifest), so the pass — which holds the decomposition —
 * enforces the dependency floor itself: for every edge `from -> to`, `from` is
 * read before `to`. A violation is fail-closed: the attempt is treated as
 * rejected and the deterministic baseline stands. Ids not both present in the
 * order are the validator's/ manifest's concern (V111/V112), not this check's.
 */
function orderDependencyViolations(
  body: unknown,
  edges: readonly DecompositionEdge[],
): ValidationError[] {
  const order = (body as OrderingBody).readingOrder;
  const position = new Map<string, number>();
  order.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  const errors: ValidationError[] = [];
  for (const edge of edges) {
    const fromPos = position.get(edge.from);
    const toPos = position.get(edge.to);
    if (fromPos === undefined || toPos === undefined) continue;
    if (fromPos >= toPos) {
      errors.push({
        code: "ORDER_DEPENDENCY",
        pointer: "/body/readingOrder",
        message: `reading order violates dependency ${edge.from} -> ${edge.to} (a chunk is placed before something it depends on)`,
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
  seed: OrderingProvenanceSeed,
  route: "agentic" | "deterministic",
  inputDigest: string,
  runId: string,
  tokens: RspTokenUsage,
  executor?: TurnExecutorFacts,
): RspProvenance {
  // Honest executor provenance (#88): when the turn reported what actually ran
  // (a Codex utility-port turn → utility/light), stamp that; otherwise the seat's
  // default (agentic/heavy for a Claude harness turn, deterministic for the floor).
  return {
    harness: seed.harness,
    harnessVersion: seed.harnessVersion,
    adapterVersion: seed.adapterVersion,
    model: seed.model,
    modelReportedBy: seed.modelReportedBy,
    tier: executor?.tier ?? (route === "deterministic" ? "deterministic" : "heavy"),
    route: executor?.route ?? route,
    runId,
    inputDigest,
    capability: executor?.capability ?? seed.capability,
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
    docType: "ordering",
    schemaVersion: 1,
    docId,
    patchsetId,
    provenance,
    body,
    x: {},
  };
}

/**
 * Drive the comprehension-ordering pass to a validator-admitted `ordering`
 * document. Assembles the contract prompt over the chunk ids and their baseline
 * order, runs the injected turn, stamps a trustworthy envelope around the
 * emitted body, validates, and on rejection retries with the report fed back —
 * falling back to the deterministic baseline on terminal failure. There is no
 * user-approval step: the agent produces the order and the validator admits it.
 */
export async function runOrderingPass(input: RunOrderingPassInput): Promise<RunOrderingPassResult> {
  const {
    proposal,
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

  const baselineOrder = [...proposal.readingOrder];
  const patchsetRef = { id: patchsetId };
  const manifest = buildChunkManifest(proposal);
  const inputDigest = computeInputDigest(patchsetRef, manifest);
  const base = renderBaseInstruction(contract);
  const payload = renderPayload(proposal, patchsetId);

  const attempts: OrderingAttempt[] = [];
  let lastReportText: string | undefined;
  let budgetRefused = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // The live budget gate (R10, #260): consult the shared budget before
    // spending a turn. A turn over a CONFIGURED ceiling is refused; an ABSENT
    // budget runs UNGATED — no budget means no ceiling, not no spend (#260). A
    // refusal is terminal — fall to the deterministic baseline.
    const purpose = `ordering:attempt-${attempt}`;
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
      turn.executor,
    );
    const document = buildEnvelope(turn.body, patchsetId, provenance, mintDocId());
    const report = validateDocument({ document, patchset: patchsetRef, manifest });
    if (report.admitted) {
      // The document is well-formed; now enforce the dependency floor the
      // validator cannot see. A clean order is admitted; a violation is
      // fail-closed and fed back like any other rejection.
      const dependencyErrors = orderDependencyViolations(turn.body, proposal.edges);
      if (dependencyErrors.length === 0) {
        attempts.push({ attempt, outcome: "admitted", report });
        return {
          admitted: true,
          usedFallback: false,
          document,
          report,
          attempts,
          baselineOrder,
          budgetRefused,
        };
      }
      const dependencyReport: ValidationReport = {
        ...report,
        admitted: false,
        errors: dependencyErrors,
      };
      attempts.push({ attempt, outcome: "rejected", report: dependencyReport });
      lastReportText = renderReport(dependencyReport);
      continue;
    }
    attempts.push({ attempt, outcome: "rejected", report });
    lastReportText = renderReport(report);
  }

  // Terminal failure (rejected out, turn failed, or budget refused): the
  // deterministic baseline stands, admitted, route recorded.
  const fallbackBody = deterministicOrderingBody(proposal);
  const provenance = buildProvenance(seed, "deterministic", inputDigest, newRunId(), ZERO_TOKENS);
  const document = buildEnvelope(fallbackBody, patchsetId, provenance, mintDocId());
  const report = validateDocument({ document, patchset: patchsetRef, manifest });
  return {
    admitted: report.admitted,
    usedFallback: true,
    document,
    report,
    attempts,
    baselineOrder,
    budgetRefused,
  };
}

/** The live reading order together with the provenance route recording which
 *  order is live: the agent order when it was admitted, the baseline otherwise.
 *  This is the consumer surface a canvas reads — the document itself carries the
 *  live order, so there is no branch for a consumer to get wrong. */
export function resolveLiveOrder(result: RunOrderingPassResult): {
  readingOrder: string[];
  route: RspRoute;
} {
  const body = result.document.body as OrderingBody;
  return { readingOrder: [...body.readingOrder], route: result.document.provenance.route };
}
