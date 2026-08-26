/**
 * The LLM knowledge ENRICHMENT runner (layer c, #14 knowledge half — design §6/§2b).
 *
 * This is the ONE place a model writes into the Repo Map, and it is off the
 * review's fail-closed critical path (design §7): a review reads the structural
 * map (a) + symbolic surface (b) model-free; knowledge (c) is best-effort and
 * disclosed-when-partial. The module is still node-free — the model turn is an
 * INJECTED `runTurn` exactly like `runHypothesisPass`, so the concrete harness
 * call lives in adapters and `core` never imports it.
 *
 * Two passes (design §2b), both bounded and budget-gated (R10, the vital money
 * circuit — an absent/exhausted budget refuses fail-closed toward LESS spend):
 *  - INITIAL enrichment (`runKnowledgeEnrichment`): one bounded turn reconstructs
 *    the initial statement set against the base snapshot.
 *  - DELTA pass (`runKnowledgeDeltaPass`): on a baseline advance, statements citing
 *    changed paths are the ones a delta re-adjudicates; untouched statements are
 *    CARRIED verbatim (never re-run), and one bounded turn over the changed regions
 *    re-adjudicates + mines net-new. Merge-train coalescing + debounce happen in the
 *    coordinator (adapters); the budget cap + changed-regions-only scope are here.
 *
 * The honesty contract is enforced at mint time, not asserted:
 *  - every emitted statement's evidence is resolved to authoritative `blobOid`s
 *    from THIS snapshot's file inventory — the model cites a `path` (+ optional
 *    symbol/lines), never a git OID it cannot know; a cited path not in the
 *    snapshot is dropped, and a statement left with NO resolvable anchor is dropped
 *    (unanchored ⇒ invalid, never served);
 *  - every minted statement is a `hypothesis` (model-derived ⇒ labelled hypothesis
 *    until confirmed), stamped with provenance + the snapshot it was learned against.
 */

import type {
  InvocationBudget,
  KnowledgeAnchor,
  KnowledgeAspect,
  KnowledgeConfidence,
  KnowledgeSet,
  KnowledgeStatement,
  KnowledgeStatus,
} from "@rennet/protocol";
import { KNOWLEDGE_SCHEMA_VERSION } from "@rennet/protocol";
import type { HarnessTurnResult } from "./harness-run-turn";
import { absentBudgetGrant } from "./invocation-budget";
import { fileBlobIndex, knowledgeStatementId } from "./knowledge";

/** The generator identity: bump on any prompt/schema change (invalidates old statements honestly). */
export const KNOWLEDGE_GENERATOR_ID = "knowledge-gen@1";

/** Default bound on how many files the prompt lists (a full re-rollup would page above this). */
export const DEFAULT_KNOWLEDGE_MAX_FILES = 400;

/**
 * The JSON output schema the enrichment session is constrained to (passed as the
 * harness `outputSchema`). The model emits statements citing a repo-relative
 * `path` (+ optional `symbol`/lines); the runner resolves the authoritative
 * `blobOid` from the snapshot — the model never mints identity.
 */
export const KNOWLEDGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["statements"],
  properties: {
    statements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "aspect", "claim", "confidence", "evidence"],
        properties: {
          subject: { type: "string" },
          aspect: { type: "string", enum: ["purpose", "convention", "why"] },
          claim: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path"],
              properties: {
                path: { type: "string" },
                symbol: { type: "string" },
                startLine: { type: "integer", minimum: 1 },
                endLine: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** A compact, model-facing projection of the snapshot the enrichment reasons over. */
export interface KnowledgeSnapshotContext {
  readonly repoKey: string;
  readonly baseOid: string;
  readonly snapshotFingerprint: string;
  /** The file inventory `path → blobOid`; the anchor-resolution authority. */
  readonly files: readonly { readonly path: string; readonly blobOid: string }[];
  /** Workspace scopes (name + root) — the natural subjects to enrich. */
  readonly scopes: readonly { readonly name: string; readonly root: string }[];
}

/** The provenance a caller knows before the run; the model/apiKeySource is observed per turn. */
export interface KnowledgeProvenanceSeed {
  readonly model: string | null;
  readonly apiKeySource: string | null;
  /** Override the generator id (defaults to {@link KNOWLEDGE_GENERATOR_ID}). */
  readonly generator?: string;
}

const CONFIDENCES: readonly KnowledgeConfidence[] = ["high", "medium", "low"];
const ASPECTS: readonly KnowledgeAspect[] = ["purpose", "convention", "why"];

function coerceAspect(value: unknown): KnowledgeAspect {
  return ASPECTS.includes(value as KnowledgeAspect) ? (value as KnowledgeAspect) : "purpose";
}

function coerceConfidence(value: unknown): KnowledgeConfidence {
  // Unknown ⇒ the most conservative label; a bad confidence never inflates trust.
  return CONFIDENCES.includes(value as KnowledgeConfidence)
    ? (value as KnowledgeConfidence)
    : "low";
}

/** How many raw anchors were dropped as unresolvable, for honest telemetry. */
interface MintTally {
  droppedAnchors: number;
  droppedStatements: number;
}

/**
 * Turn one raw model statement into a trustworthy {@link KnowledgeStatement}, or
 * `undefined` when it has no resolvable anchor. Every anchor's `blobOid` is stamped
 * from the snapshot's file inventory (the model cites paths, never OIDs); an anchor
 * whose path is absent is dropped; a statement left unanchored is dropped.
 */
function mintStatement(
  raw: unknown,
  filesByPath: ReadonlyMap<string, string>,
  snapshot: KnowledgeSnapshotContext,
  seed: KnowledgeProvenanceSeed,
  generator: string,
  tally: MintTally,
): KnowledgeStatement | undefined {
  if (!raw || typeof raw !== "object") {
    tally.droppedStatements += 1;
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const subject = typeof record.subject === "string" ? record.subject : "";
  const claim = typeof record.claim === "string" ? record.claim.trim() : "";
  if (subject.length === 0 || claim.length === 0) {
    tally.droppedStatements += 1;
    return undefined;
  }

  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence: KnowledgeAnchor[] = [];
  for (const entry of rawEvidence) {
    if (!entry || typeof entry !== "object") {
      tally.droppedAnchors += 1;
      continue;
    }
    const anchor = entry as Record<string, unknown>;
    const path = typeof anchor.path === "string" ? anchor.path : "";
    const blobOid = filesByPath.get(path);
    if (blobOid === undefined) {
      // Cited a path not in the snapshot — unresolvable, so it cannot anchor a fact.
      tally.droppedAnchors += 1;
      continue;
    }
    const startLine = typeof anchor.startLine === "number" ? anchor.startLine : undefined;
    const endLine = typeof anchor.endLine === "number" ? anchor.endLine : undefined;
    evidence.push({
      path,
      blobOid,
      ...(typeof anchor.symbol === "string" && anchor.symbol.length > 0
        ? { symbol: anchor.symbol }
        : {}),
      ...(startLine !== undefined && startLine >= 1
        ? {
            lines:
              endLine !== undefined && endLine >= startLine
                ? { startLine, endLine }
                : { startLine },
          }
        : {}),
    });
  }
  if (evidence.length === 0) {
    // Unanchored ⇒ invalid; never served (spec repo-map-knowledge).
    tally.droppedStatements += 1;
    return undefined;
  }

  const aspect = coerceAspect(record.aspect);
  return {
    id: knowledgeStatementId({ subject, aspect, claim, evidence }),
    subject,
    aspect,
    claim,
    evidence,
    confidence: coerceConfidence(record.confidence),
    // Model-derived ⇒ a labelled hypothesis until confirmed.
    status: "hypothesis",
    provenance: { generator, model: seed.model, apiKeySource: seed.apiKeySource },
    learnedAgainst: {
      baseOid: snapshot.baseOid,
      snapshotFingerprint: snapshot.snapshotFingerprint,
    },
  };
}

function parseStatements(body: unknown): readonly unknown[] {
  if (!body || typeof body !== "object") return [];
  const statements = (body as Record<string, unknown>).statements;
  return Array.isArray(statements) ? statements : [];
}

/** Dedup minted statements by id (a re-adjudicated claim and a survivor can coincide). */
function dedupById(statements: readonly KnowledgeStatement[]): KnowledgeStatement[] {
  const byId = new Map<string, KnowledgeStatement>();
  for (const statement of statements)
    if (!byId.has(statement.id)) byId.set(statement.id, statement);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── Prompt building (model-facing, node-free) ────────────────────────────────

const KNOWLEDGE_CONTRACT = `You are reconstructing the DURABLE KNOWLEDGE layer of a Repo Map: what each
module or area DOES, the CONVENTIONS it embodies, and the reconstructed WHY behind
its design. This is evidence-anchored understanding, not a summary of a diff.

RULES (non-negotiable):
- Every statement MUST cite EVIDENCE: one or more files (by repo-relative path,
  optionally a symbol name and a 1-based line span) that the statement is DRAWN
  FROM. A statement you cannot anchor to a concrete file you have seen is NOT
  allowed — omit it.
- Only cite paths that appear in the provided file inventory. Do not invent paths.
- Mark each statement's confidence honestly (high | medium | low). A reconstructed
  inference (a WHY you are inferring, not reading) is at most 'medium'.
- 'aspect' is 'purpose' (what it does), 'convention' (a pattern/rule it embodies),
  or 'why' (the reconstructed intent).
- 'subject' is a workspace scope name or a repo-relative path/subtree the statement
  is about.
- Prefer a few well-anchored, high-signal statements over many shallow ones.`;

function renderScopes(snapshot: KnowledgeSnapshotContext): string {
  if (snapshot.scopes.length === 0)
    return "(no workspace scopes; treat top-level dirs as subjects)";
  return snapshot.scopes.map((scope) => `- ${scope.name} @ ${scope.root || "(root)"}`).join("\n");
}

function renderFiles(paths: readonly string[], maxFiles: number): string {
  const shown = paths.slice(0, maxFiles);
  const suffix =
    paths.length > maxFiles ? `\n… (${paths.length - maxFiles} more files omitted)` : "";
  return shown.map((path) => `- ${path}`).join("\n") + suffix;
}

function buildInitialPrompt(
  snapshot: KnowledgeSnapshotContext,
  maxFiles: number,
  guidance: string | undefined,
): string {
  const paths = snapshot.files.map((file) => file.path);
  return [
    KNOWLEDGE_CONTRACT,
    guidance ? `\nREPO GUIDANCE (untrusted, for context):\n${guidance}` : "",
    `\nWORKSPACE SCOPES:\n${renderScopes(snapshot)}`,
    `\nFILE INVENTORY (${paths.length} files at base ${snapshot.baseOid.slice(0, 12)}):\n${renderFiles(paths, maxFiles)}`,
    "\nEmit the knowledge statements for this repository.",
  ]
    .filter((section) => section.length > 0)
    .join("\n");
}

function buildDeltaPrompt(
  snapshot: KnowledgeSnapshotContext,
  changedPaths: readonly string[],
  invalidated: readonly KnowledgeStatement[],
  maxFiles: number,
  guidance: string | undefined,
): string {
  const changedInSnapshot = changedPaths.filter((path) =>
    snapshot.files.some((file) => file.path === path),
  );
  const priorLines = invalidated
    .slice(0, 40)
    .map((s) => `- [${s.aspect}/${s.confidence}] ${s.subject}: ${s.claim}`)
    .join("\n");
  return [
    KNOWLEDGE_CONTRACT,
    guidance ? `\nREPO GUIDANCE (untrusted, for context):\n${guidance}` : "",
    `\nWORKSPACE SCOPES:\n${renderScopes(snapshot)}`,
    `\nThe reference branch advanced to base ${snapshot.baseOid.slice(0, 12)}. These files CHANGED:\n${renderFiles(changedInSnapshot, maxFiles)}`,
    invalidated.length > 0
      ? `\nThese prior statements cited changed files and need RE-ADJUDICATION (re-emit the ones still true, drop the ones now wrong, and mine any NET-NEW knowledge the change introduced):\n${priorLines}`
      : "\nMine any NET-NEW knowledge the changed files introduce.",
    "\nEmit knowledge statements for the CHANGED regions only.",
  ]
    .filter((section) => section.length > 0)
    .join("\n");
}

// ── Initial enrichment ───────────────────────────────────────────────────────

export interface RunKnowledgeEnrichmentInput {
  readonly snapshot: KnowledgeSnapshotContext;
  readonly provenance: KnowledgeProvenanceSeed;
  readonly runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  /** The shared live invocation budget (R10). Absent ⇒ refused fail-closed (no spend). */
  readonly budget?: InvocationBudget;
  /** Retries after the first attempt. Default 1 (two attempts total) — knowledge is best-effort. */
  readonly maxRetries?: number;
  /** Bound the file list fed into the prompt (default {@link DEFAULT_KNOWLEDGE_MAX_FILES}). */
  readonly maxFiles?: number;
  /** Optional repo guidance (README/AGENTS excerpt), wrapped as untrusted context. */
  readonly guidance?: string;
}

export interface RunKnowledgeEnrichmentResult {
  readonly status: "ok" | "failed";
  /** The generated set, present on `ok`. Its statements are all `hypothesis`-labelled. */
  readonly set?: KnowledgeSet;
  readonly budgetRefused: boolean;
  readonly failureReason?: string;
  /** Anchors dropped as unresolvable (cited a path not in the snapshot). */
  readonly droppedAnchors: number;
  /** Statements dropped as unanchored/malformed. */
  readonly droppedStatements: number;
  readonly attempts: number;
}

/**
 * Run the initial knowledge enrichment against a base snapshot. Budget-gated and
 * bounded: at most `maxRetries + 1` turns, each consulting the shared budget
 * first. Emitted statements are minted with authoritative anchors resolved from
 * the snapshot (unresolvable anchors and unanchored statements dropped) and
 * labelled `hypothesis`. A terminal turn failure or budget refusal resolves to an
 * honest `failed` (knowledge degrades to absent, never a fabricated set).
 */
export async function runKnowledgeEnrichment(
  input: RunKnowledgeEnrichmentInput,
): Promise<RunKnowledgeEnrichmentResult> {
  const { snapshot, provenance, runTurn, budget, maxRetries = 1 } = input;
  const maxFiles = input.maxFiles ?? DEFAULT_KNOWLEDGE_MAX_FILES;
  const generator = provenance.generator ?? KNOWLEDGE_GENERATOR_ID;
  const filesByPath = fileBlobIndex(snapshot.files);
  const prompt = buildInitialPrompt(snapshot, maxFiles, input.guidance);

  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };
  let budgetRefused = false;
  let lastFailure = "the knowledge enrichment did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const purpose = `knowledge:initial:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      budgetRefused = true;
      lastFailure = grant.reason;
      break;
    }
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    const minted = parseStatements(turn.body)
      .map((raw) => mintStatement(raw, filesByPath, snapshot, provenance, generator, tally))
      .filter((s): s is KnowledgeStatement => s !== undefined);
    const set: KnowledgeSet = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      repoKey: snapshot.repoKey,
      baseOid: snapshot.baseOid,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      generator,
      statements: dedupById(minted),
    };
    return {
      status: "ok",
      set,
      budgetRefused,
      droppedAnchors: tally.droppedAnchors,
      droppedStatements: tally.droppedStatements,
      attempts: attempt + 1,
    };
  }

  return {
    status: "failed",
    budgetRefused,
    failureReason: lastFailure,
    droppedAnchors: tally.droppedAnchors,
    droppedStatements: tally.droppedStatements,
    attempts: maxRetries + 1,
  };
}

// ── Delta pass (changed regions only) ────────────────────────────────────────

/** Whether a statement cites any of the changed paths (⇒ needs re-adjudication). */
export function statementIntersectsChange(
  statement: KnowledgeStatement,
  changed: ReadonlySet<string>,
): boolean {
  return statement.evidence.some((anchor) => changed.has(anchor.path));
}

export interface RunKnowledgeDeltaPassInput {
  /** The NEW snapshot the reference branch advanced to. */
  readonly snapshot: KnowledgeSnapshotContext;
  /** The prior stored set (learned against the previous snapshot). */
  readonly priorSet: KnowledgeSet;
  /** The `old..new` changed-path closure. */
  readonly changedPaths: readonly string[];
  readonly provenance: KnowledgeProvenanceSeed;
  readonly runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  readonly budget?: InvocationBudget;
  readonly maxRetries?: number;
  readonly maxFiles?: number;
  readonly guidance?: string;
}

export interface RunKnowledgeDeltaPassResult {
  readonly status: "ok" | "failed" | "skipped";
  /** The merged set: carried survivors + re-adjudicated + net-new, pinned to the new snapshot. */
  readonly set?: KnowledgeSet;
  /** Prior statements that cited changed files (invalidated; re-adjudicated this pass). */
  readonly invalidated: readonly KnowledgeStatement[];
  /** Survivors carried verbatim, NOT re-run (their cited bytes are unchanged). */
  readonly carried: number;
  readonly budgetRefused: boolean;
  readonly failureReason?: string;
  readonly droppedAnchors: number;
  readonly droppedStatements: number;
}

/**
 * The bounded knowledge delta pass (design §2b): on a baseline advance, carry the
 * untouched statements verbatim (their cited bytes are unchanged, so they stay
 * valid — never re-run), and run ONE bounded, budget-gated turn over ONLY the
 * changed regions to re-adjudicate the invalidated statements and mine net-new.
 * Never blocks a review; a failure leaves the prior knowledge visible (the caller
 * keeps the old set) and resolves to an honest `failed`.
 *
 * With no changed paths it is a `skipped` no-op (nothing to re-adjudicate).
 */
export async function runKnowledgeDeltaPass(
  input: RunKnowledgeDeltaPassInput,
): Promise<RunKnowledgeDeltaPassResult> {
  const { snapshot, priorSet, provenance, runTurn, budget, maxRetries = 1 } = input;
  const maxFiles = input.maxFiles ?? DEFAULT_KNOWLEDGE_MAX_FILES;
  const generator = provenance.generator ?? KNOWLEDGE_GENERATOR_ID;
  const changed = new Set(input.changedPaths);

  const carried: KnowledgeStatement[] = [];
  const invalidated: KnowledgeStatement[] = [];
  for (const statement of priorSet.statements) {
    if (statementIntersectsChange(statement, changed)) invalidated.push(statement);
    else carried.push(statement);
  }

  // A human disposition (confirmed/rejected) is durable by statement id: if the
  // re-adjudication turn re-mints the SAME claim (same id — e.g. a mode-only change,
  // or the model re-emits an identical claim), it keeps the human's status rather
  // than resurfacing as a fresh hypothesis. A genuinely changed claim gets a new id
  // (its evidence blobOid moved) and is correctly a new hypothesis.
  const priorDisposition = new Map<string, KnowledgeStatus>();
  for (const statement of priorSet.statements)
    if (statement.status !== "hypothesis") priorDisposition.set(statement.id, statement.status);
  const applyDisposition = (statement: KnowledgeStatement): KnowledgeStatement => {
    const disposed = priorDisposition.get(statement.id);
    return disposed && disposed !== statement.status
      ? { ...statement, status: disposed }
      : statement;
  };

  if (changed.size === 0) {
    return {
      status: "skipped",
      invalidated,
      carried: carried.length,
      budgetRefused: false,
      droppedAnchors: 0,
      droppedStatements: 0,
    };
  }

  const filesByPath = fileBlobIndex(snapshot.files);
  const prompt = buildDeltaPrompt(
    snapshot,
    input.changedPaths,
    invalidated,
    maxFiles,
    input.guidance,
  );

  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };
  let budgetRefused = false;
  let lastFailure = "the knowledge delta pass did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const purpose = `knowledge:delta:attempt-${attempt}`;
    const grant = budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      budgetRefused = true;
      lastFailure = grant.reason;
      break;
    }
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    const minted = parseStatements(turn.body)
      .map((raw) => mintStatement(raw, filesByPath, snapshot, provenance, generator, tally))
      .filter((s): s is KnowledgeStatement => s !== undefined);
    // Carried survivors keep their original learnedAgainst (honest: they were not
    // re-reconstructed); the SET is now pinned to the new snapshot.
    const set: KnowledgeSet = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      repoKey: snapshot.repoKey,
      baseOid: snapshot.baseOid,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      generator,
      statements: dedupById([...carried, ...minted]).map(applyDisposition),
    };
    return {
      status: "ok",
      set,
      invalidated,
      carried: carried.length,
      budgetRefused,
      droppedAnchors: tally.droppedAnchors,
      droppedStatements: tally.droppedStatements,
    };
  }

  return {
    status: "failed",
    invalidated,
    carried: carried.length,
    budgetRefused,
    failureReason: lastFailure,
    droppedAnchors: tally.droppedAnchors,
    droppedStatements: tally.droppedStatements,
  };
}
