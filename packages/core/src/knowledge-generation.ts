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

import type { InvocationBudget, KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { KNOWLEDGE_SCHEMA_VERSION } from "@rennet/protocol";
import type { HarnessTurnResult } from "./harness-run-turn";
import { absentBudgetGrant } from "./invocation-budget";
import { fileBlobIndex } from "./knowledge";
import { dispositionCarrier, statementIntersectsChange } from "./knowledge/incremental";
import {
  dedupById,
  KNOWLEDGE_CONTRACT,
  type MintTally,
  mintStatement,
  parseStatements,
} from "./knowledge/mint";

/** The generator identity: bump on any prompt/schema change (invalidates old statements honestly). */
export const KNOWLEDGE_GENERATOR_ID = "knowledge-gen@1";

/** Default bound on how many files the prompt lists (a full re-rollup would page above this). */
export const DEFAULT_KNOWLEDGE_MAX_FILES = 400;

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

// ── Prompt building (model-facing, node-free) ────────────────────────────────

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
// `statementIntersectsChange` + disposition durability extracted to
// knowledge/incremental.ts (cluster 4); imported above. No re-export here — the
// root index star-exports both modules, and a duplicate name would be silently
// dropped from the seam as an ambiguous star export.

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

  // Disposition durability by statement id — the shipped rule, now shared with
  // the swarm's incremental path (knowledge/incremental.ts).
  const applyDisposition = dispositionCarrier(priorSet);

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
