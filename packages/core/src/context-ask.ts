/**
 * The `context.ask` synthesis runner (issue #15) — one question, one validated
 * answer document, composed from the ALREADY-BUILT deterministic reads plus one
 * injected model turn.
 *
 * This is a pure, node-free runner in the mould of the knowledge swarm passes
 * (`knowledge/swarm.ts`): the model turn is an INJECTED `runTurn(prompt,
 * attempt)` so the concrete harness call lives in adapters and `core` never
 * imports it. It composes context from the existing pure reads —
 * `queryKnowledge` (`knowledge/read.ts`) plus `queryProjectMap` / `queryFileContext`
 * / `querySymbolDefinition` / `queryReferences` (`project-context.ts`) over a
 * materialized snapshot — and returns exactly the wire shape `contextAnswerSchema`
 * carries (`protocol/src/wire.ts`): `{answer, evidence, confidence, unanswered?}`
 * plus a `cost` report.
 *
 * Three honesty rules are enforced HERE, at synthesis time, not asserted downstream:
 *  - Evidence-or-fail: an answer that makes claims (a non-empty `answer`) with an
 *    empty resolvable-evidence set is INVALID — reported as a `failed` ask, never
 *    rendered as a clean answer (anti-hallucination, which Rule Zero protects as
 *    anti-lie-in-the-UI).
 *  - `unanswered`-with-reason is a first-class SUCCESS: when the snapshot/knowledge
 *    demonstrably cannot support an answer, the runner returns `unanswered` with a
 *    reason naming what was consulted. Not an error, not a guess.
 *  - Budget METERS and REPORTS, never refuses (Rule Zero): the injected
 *    `InvocationBudget` is consulted and its verdict recorded into `cost`, but a
 *    `thorough` ask with no headroom STILL runs and reports its overage. There is
 *    no refusal path.
 *
 * Model routing is resolved through the Model Council's pre-declared
 * `context-ask-fetch` (light / quick) and `context-ask-thorough` (heavy) seats by
 * `budgetHint`, carrying the honest resolution trace into `cost`.
 */

import type {
  CouncilEffort,
  CouncilResolveContext,
  CouncilTier,
  InvocationBudget,
  KnowledgeAnchor,
  KnowledgeConfidence,
  KnowledgeSet,
  KnowledgeStatement,
  ResolutionTrace,
} from "@rennet/protocol";
import type { HarnessTurnResult } from "./harness-run-turn";
import { absentBudgetGrant } from "./invocation-budget";
import { queryKnowledge } from "./knowledge";
import { resolveAssignment } from "./model-council";
import { type LoadedSnapshot, queryProjectMap } from "./project-context";

/** How hard to think: `quick` routes the light fetch seat, `thorough` the heavy seat. */
export type ContextAskBudgetHint = "quick" | "thorough";

/** A `context.ask` request: a question, optionally scoped, with a routing hint. */
export interface ContextAskQuery {
  readonly question: string;
  /** Restrict the consulted context to a scope name or repo-relative subtree. */
  readonly scope?: string;
  /** Routing hint (default `quick`). `thorough` routes the heavy council seat. */
  readonly budgetHint?: ContextAskBudgetHint;
}

/**
 * The metered spend of one ask — ALWAYS present, on every outcome (a failed ask
 * still spent a turn). `budgetGranted` is whether the shared budget had headroom;
 * `overage` is true when the ask ran anyway despite no headroom (Rule Zero: meter
 * and report, never refuse). `resolution` is the honest council trace.
 */
export interface ContextAskCost {
  /** How many model turns the ask consumed. */
  readonly turns: number;
  /** The resolved model, or null on a (defensive) deterministic resolution. */
  readonly model: string | null;
  /** The resolved effort, or null on a deterministic resolution. */
  readonly effort: CouncilEffort | null;
  /** Whether the shared invocation budget had headroom for this ask. */
  readonly budgetGranted: boolean;
  /** True when the ask ran despite an exhausted budget (the reported overage). */
  readonly overage: boolean;
  /** The council's inspectable "why this model" trace. */
  readonly resolution: ResolutionTrace;
}

/**
 * The validated answer document — the shape the PROTOCOL_CARD advertises plus a
 * cost report. `evidence` carries the resolvable anchors every claim rests on;
 * `consulted` names the reads that fed the answer; `unanswered` (when present)
 * marks a first-class honest non-answer.
 */
export interface ContextAnswer {
  readonly answer: string;
  readonly evidence: readonly KnowledgeAnchor[];
  readonly confidence: KnowledgeConfidence;
  readonly consulted: readonly string[];
  readonly cost: ContextAskCost;
  readonly unanswered?: { readonly reason: string };
}

/**
 * The runner's outcome: an evidence-backed `answered` document, a first-class
 * `unanswered` success, or a `failed` ask (a malformed/evidence-free answer or a
 * turn failure) — never a clean answer without evidence.
 */
export type RunContextAskResult =
  | { readonly status: "answered"; readonly answer: ContextAnswer }
  | { readonly status: "unanswered"; readonly answer: ContextAnswer }
  | { readonly status: "failed"; readonly failureReason: string; readonly cost: ContextAskCost };

/** The JSON output schema the ask turn is constrained to (the harness `outputSchema`). */
export const CONTEXT_ASK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "confidence", "evidence"],
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "path"],
        properties: {
          evidenceId: { type: "string" },
          path: { type: "string" },
          symbol: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
      },
    },
    unanswered: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: { reason: { type: "string" } },
    },
  },
} as const;

const CONFIDENCES: readonly KnowledgeConfidence[] = ["high", "medium", "low"];

function coerceConfidence(value: unknown): KnowledgeConfidence {
  // Unknown ⇒ the most conservative label; a bad confidence never inflates trust.
  return CONFIDENCES.includes(value as KnowledgeConfidence)
    ? (value as KnowledgeConfidence)
    : "low";
}

/**
 * One claim-bearing evidence anchor offered to the model. The id binds a citation
 * to the exact knowledge statement and anchor shown in the prompt; a path name by
 * itself is never evidence.
 */
interface OfferedEvidence {
  readonly id: string;
  readonly statementId: string;
  readonly claim: string;
  readonly anchor: KnowledgeAnchor;
}

interface ResolvedAnchors {
  readonly anchors: readonly KnowledgeAnchor[];
  readonly invalid: boolean;
}

/** Whether a model-provided span stays within the exact offered anchor span. */
function spanWithin(
  startLine: unknown,
  endLine: unknown,
  offered: KnowledgeAnchor["lines"],
): boolean {
  if (startLine === undefined && endLine === undefined) return true;
  if (
    offered === undefined ||
    typeof startLine !== "number" ||
    !Number.isInteger(startLine) ||
    startLine < 1
  )
    return false;
  if (endLine !== undefined && (typeof endLine !== "number" || !Number.isInteger(endLine)))
    return false;
  const citedEnd = endLine ?? startLine;
  const offeredEnd = offered.endLine ?? offered.startLine;
  return citedEnd >= startLine && startLine >= offered.startLine && citedEnd <= offeredEnd;
}

/**
 * Resolve EVERY model citation against the claim-bearing evidence actually offered
 * in the prompt. One fabricated id/path/symbol/span invalidates the whole answer;
 * invalid citations are never silently dropped while another valid citation lets
 * the claim through.
 */
function resolveAnchors(
  raw: unknown,
  offeredById: ReadonlyMap<string, OfferedEvidence>,
): ResolvedAnchors {
  if (!Array.isArray(raw)) return { anchors: [], invalid: true };
  const anchors: KnowledgeAnchor[] = [];
  let invalid = false;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      invalid = true;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const offered =
      typeof record.evidenceId === "string" ? offeredById.get(record.evidenceId) : undefined;
    if (
      offered === undefined ||
      record.path !== offered.anchor.path ||
      (record.symbol !== undefined && record.symbol !== offered.anchor.symbol) ||
      !spanWithin(record.startLine, record.endLine, offered.anchor.lines)
    ) {
      invalid = true;
      continue;
    }
    anchors.push(offered.anchor);
  }
  return { anchors, invalid };
}

// ── Prompt building (model-facing, node-free) ────────────────────────────────

const ASK_CONTRACT = `You are answering ONE question about a codebase from the EVIDENCE you are given
(a deterministic project map and the reconstructed knowledge layer). Answer only
from that evidence.

RULES (non-negotiable):
- Every claim in your answer MUST cite one or more OFFERED EVIDENCE IDs whose
  statement supports that claim. Copy that evidence item's id + path exactly.
  Optional symbol/line narrowing must stay within the offered anchor. Project file
  names are navigation context, NOT evidence. Do not invent ids, paths, symbols,
  or line spans.
- If the provided context does NOT support an answer, DO NOT GUESS. Return an
  "unanswered" object with a human-readable "reason" naming what you consulted and
  why it did not suffice. An honest "unanswered" is a SUCCESS, not a failure.
- Mark your confidence honestly (high | medium | low). A reconstructed inference is
  at most 'medium'.
- Prefer a short, well-anchored answer over a long, thinly-supported one.`;

function offeredEvidenceFor(statements: readonly KnowledgeStatement[]): OfferedEvidence[] {
  return statements.flatMap((statement) =>
    statement.evidence.map((anchor, index) => ({
      id: `${statement.id}:${index}`,
      statementId: statement.id,
      claim: statement.claim,
      anchor,
    })),
  );
}

function renderAnchor(anchor: KnowledgeAnchor): string {
  const symbol = anchor.symbol ? ` symbol=${anchor.symbol}` : "";
  const lines = anchor.lines
    ? ` lines=${anchor.lines.startLine}-${anchor.lines.endLine ?? anchor.lines.startLine}`
    : "";
  return `${anchor.path}${symbol}${lines}`;
}

function renderConsultedContext(
  evidence: readonly OfferedEvidence[],
  paths: readonly string[],
): string {
  const knowledgeBlock =
    evidence.length > 0
      ? `OFFERED EVIDENCE (reconstructed knowledge; cite by evidence id):\n${evidence
          .map(
            (item) =>
              `- evidence=${item.id} statement=${item.statementId} anchor=${renderAnchor(item.anchor)}\n  claim: ${item.claim}`,
          )
          .join("\n")}`
      : "OFFERED EVIDENCE: (none; return unanswered)";
  const filesBlock =
    paths.length > 0
      ? `PROJECT FILE NAMES (navigation only; NOT evidence) (${paths.length}):\n${paths.map((p) => `- ${p}`).join("\n")}`
      : "PROJECT FILE NAMES: (none)";
  return `${knowledgeBlock}\n\n${filesBlock}`;
}

/** Bound the file/knowledge listing fed into the prompt (context-window economy). */
const DEFAULT_ASK_MAX_FILES = 400;
const DEFAULT_ASK_MAX_STATEMENTS = 80;

export interface RunContextAskInput {
  /** The materialized snapshot the ask reads over (the anchor-resolution authority). */
  readonly snapshot: LoadedSnapshot;
  /** The stored knowledge set (or null when not yet enriched — an honest empty view). */
  readonly knowledgeSet: KnowledgeSet | null;
  /** The question to answer. */
  readonly query: ContextAskQuery;
  /** The injected model turn (adapters own the harness; core stays node-free). */
  readonly runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  /** The council context the model routing resolves against. */
  readonly council: CouncilResolveContext;
  /** The shared live invocation budget. Metered + reported, NEVER used to refuse. */
  readonly budget?: InvocationBudget;
  /** Retries after the first attempt. Default 1 (two attempts total). */
  readonly maxRetries?: number;
  readonly maxFiles?: number;
  readonly maxStatements?: number;
  /** Observe every actual model attempt so the live backend can append its run ledger row. */
  readonly onAttempt?: (attempt: ContextAskAttempt) => void;
}

export interface ContextAskAttempt {
  readonly attempt: number;
  readonly purpose: string;
  readonly budgetHint: ContextAskBudgetHint;
  readonly tier: CouncilTier;
  readonly model: string | null;
  readonly budgetGranted: boolean;
  readonly budgetRemaining: number;
  readonly outcome: "answered" | "unanswered" | "rejected" | "turn-failed";
}

/**
 * Run one `context.ask`. Resolves the model by `budgetHint`, composes context from
 * the existing pure reads, meters the shared budget (never refusing), runs the
 * injected turn, and validates the emitted document: an evidence-backed answer is
 * `answered`, an `unanswered`-with-reason is a `unanswered` success, and a
 * claim-with-no-resolvable-evidence (or a turn failure) is a `failed` ask.
 */
export async function runContextAsk(input: RunContextAskInput): Promise<RunContextAskResult> {
  const { snapshot, knowledgeSet, query, runTurn, council, budget, maxRetries = 1 } = input;
  const maxFiles = input.maxFiles ?? DEFAULT_ASK_MAX_FILES;
  const maxStatements = input.maxStatements ?? DEFAULT_ASK_MAX_STATEMENTS;
  const budgetHint = query.budgetHint ?? "quick";

  // Model routing: the pre-declared council seats, resolved by budgetHint.
  const jobId = budgetHint === "thorough" ? "context-ask-thorough" : "context-ask-fetch";
  const resolution = resolveAssignment(jobId, council);
  const model = resolution.kind === "model" ? resolution.model : null;
  const effort = resolution.kind === "model" ? resolution.effort : null;

  // Compose the consulted context from the existing pure reads.
  // ponytail: `query.scope` is read two ways — an exact knowledge subject and a map path
  // prefix — because a scope name and a path are distinct namespaces. No caller sends a
  // scope yet (the UI asks project-wide), so this stays unresolved; when one does, resolve
  // a scope name to its root path before the map read so both narrow the same region.
  const knowledgeView = queryKnowledge(
    knowledgeSet,
    snapshot,
    query.scope !== undefined ? { subject: query.scope } : undefined,
  );
  const map = queryProjectMap(
    snapshot,
    query.scope !== undefined ? { path: query.scope } : undefined,
  );
  // A `rejected` statement is one the human explicitly disowned; never offer it
  // to the orchestrator as evidence (change add-context-map-view, task 4.5).
  const offerable = knowledgeView.statements.filter((s) => s.status !== "rejected");
  const offeredEvidence = offeredEvidenceFor(offerable.slice(0, maxStatements));
  const offeredById = new Map(offeredEvidence.map((evidence) => [evidence.id, evidence]));
  const paths = map.files.map((f) => f.path).slice(0, maxFiles);
  const consulted = [
    `context.knowledge (${knowledgeView.statements.length} statements)`,
    `context.map (${map.files.length} files)`,
  ];

  const prompt = [
    ASK_CONTRACT,
    `\nQUESTION:\n${query.question}`,
    `\nCONTEXT (at base ${snapshot.manifest.baseOid.slice(0, 12)}):\n${renderConsultedContext(offeredEvidence, paths)}`,
    '\nAnswer the question from this evidence, or return an honest "unanswered".',
  ].join("\n");

  let turns = 0;
  let budgetGranted = true;
  let overage = false;
  let lastFailure = "the context.ask turn did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const purpose = `context-ask:${budgetHint}:attempt-${attempt}`;
    // Meter, never refuse (Rule Zero): consult the budget and RECORD its verdict,
    // but run the turn regardless. A `thorough` ask with no headroom still answers.
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      budgetGranted = false;
      overage = true;
    }
    turns += 1;
    const cost: ContextAskCost = {
      turns,
      model,
      effort,
      budgetGranted,
      overage,
      resolution: resolution.trace,
    };

    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      input.onAttempt?.({
        attempt,
        purpose,
        budgetHint,
        tier: resolution.trace.tier,
        model,
        budgetGranted: grant.granted,
        budgetRemaining: budget?.remaining ?? Number.POSITIVE_INFINITY,
        outcome: "turn-failed",
      });
      lastFailure = turn.message;
      continue;
    }

    const body = (turn.body ?? {}) as Record<string, unknown>;

    // `unanswered`-with-reason is a first-class SUCCESS (anti-hallucination).
    const rawUnanswered = body.unanswered;
    if (rawUnanswered && typeof rawUnanswered === "object") {
      const reason = (rawUnanswered as Record<string, unknown>).reason;
      if (typeof reason === "string" && reason.trim().length > 0) {
        input.onAttempt?.({
          attempt,
          purpose,
          budgetHint,
          tier: resolution.trace.tier,
          model,
          budgetGranted: grant.granted,
          budgetRemaining: budget?.remaining ?? Number.POSITIVE_INFINITY,
          outcome: "unanswered",
        });
        return {
          status: "unanswered",
          answer: {
            answer: "",
            evidence: [],
            confidence: coerceConfidence(body.confidence),
            consulted,
            cost,
            unanswered: { reason: reason.trim() },
          },
        };
      }
    }

    const answerText = typeof body.answer === "string" ? body.answer.trim() : "";
    const resolved = resolveAnchors(body.evidence, offeredById);
    const evidence = resolved.anchors;

    // Evidence-or-fail: a claim (non-empty answer) with no resolvable evidence is
    // invalid — a failed ask, never a clean answer.
    if (answerText.length === 0 || evidence.length === 0 || resolved.invalid) {
      input.onAttempt?.({
        attempt,
        purpose,
        budgetHint,
        tier: resolution.trace.tier,
        model,
        budgetGranted: grant.granted,
        budgetRemaining: budget?.remaining ?? Number.POSITIVE_INFINITY,
        outcome: "rejected",
      });
      lastFailure =
        answerText.length === 0
          ? "the ask turn returned neither an answer nor an unanswered reason"
          : "the ask turn produced an answer with evidence not offered for its claims";
      continue;
    }

    input.onAttempt?.({
      attempt,
      purpose,
      budgetHint,
      tier: resolution.trace.tier,
      model,
      budgetGranted: grant.granted,
      budgetRemaining: budget?.remaining ?? Number.POSITIVE_INFINITY,
      outcome: "answered",
    });

    return {
      status: "answered",
      answer: {
        answer: answerText,
        evidence,
        confidence: coerceConfidence(body.confidence),
        consulted,
        cost,
      },
    };
  }

  return {
    status: "failed",
    failureReason: lastFailure,
    cost: {
      turns,
      model,
      effort,
      budgetGranted,
      overage,
      resolution: resolution.trace,
    },
  };
}
