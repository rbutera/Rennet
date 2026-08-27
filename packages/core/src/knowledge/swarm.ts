/**
 * The partitioned knowledge swarm (#460): light-tier workers emit full anchored
 * statements per slice; a verify/synthesis seat confirms hypotheses itself and
 * mints the cross-cutting statements no single worker could see.
 *
 * Both passes are pure over an injected `runTurn` (the council-routed harness
 * wiring lives in adapters), and neither takes an `InvocationBudget` — the map
 * path is uncapped by decision (#460 point 5, proposal reconciliation 4); R10
 * stays intact on every other model path.
 *
 * Statements are minted through `mint.ts` — the same honesty contract as the
 * flat pass (anchor-or-drop, hypothesis stamping, authoritative blobOids). The
 * worker's optional free-text `hint` exists only in the worker result envelope
 * for the synthesizer's benefit; it never enters a `KnowledgeStatement` and
 * dies at synthesis (reconciliation 7).
 */

import type { KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { KNOWLEDGE_SCHEMA_VERSION } from "@rennet/protocol";
import type { HarnessTurnResult } from "../harness-run-turn";
import type { KnowledgeProvenanceSeed, KnowledgeSnapshotContext } from "../knowledge-generation";
import {
  dedupById,
  KNOWLEDGE_CONTRACT,
  KNOWLEDGE_OUTPUT_SCHEMA,
  type MintTally,
  mintStatement,
  parseStatements,
} from "./mint";
import type { PartitionSlice } from "./partition";
import { fileBlobIndex } from "./read";

/** The swarm generator identity: bump on any prompt/schema change. */
export const KNOWLEDGE_SWARM_GENERATOR_ID = "knowledge-swarm@1";

type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

// ── Partition worker ─────────────────────────────────────────────────────────

/**
 * The worker output schema: the statement contract plus one optional free-text
 * `hint` per statement — context for the verify/synthesis seat, discardable,
 * never stored.
 */
export const PARTITION_WORKER_OUTPUT_SCHEMA = (() => {
  const statement = KNOWLEDGE_OUTPUT_SCHEMA.properties.statements.items;
  return {
    ...KNOWLEDGE_OUTPUT_SCHEMA,
    properties: {
      statements: {
        type: "array",
        items: {
          ...statement,
          properties: { ...statement.properties, hint: { type: "string" } },
        },
      },
    },
  } as const;
})();

/** One minted statement plus the worker's discardable synthesis hint. */
export interface WorkerStatement {
  readonly statement: KnowledgeStatement;
  /** Free text for the verify seat only; never enters the stored set. */
  readonly hint?: string;
}

export interface PartitionWorkerInput {
  readonly slice: PartitionSlice;
  readonly snapshot: KnowledgeSnapshotContext;
  readonly provenance: KnowledgeProvenanceSeed;
  readonly runTurn: RunTurn;
  /** Retries after the first attempt. Default 1 — knowledge is best-effort. */
  readonly maxRetries?: number;
}

export interface PartitionWorkerResult {
  readonly sliceId: string;
  readonly status: "ok" | "failed";
  readonly failureReason?: string;
  /** Minted (hypothesis-labelled) statements with their envelope-only hints. */
  readonly statements: readonly WorkerStatement[];
  readonly droppedAnchors: number;
  readonly droppedStatements: number;
  readonly attempts: number;
}

function buildWorkerPrompt(slice: PartitionSlice, snapshot: KnowledgeSnapshotContext): string {
  const paths = slice.files.map((file) => `- ${file.path}`).join("\n");
  return [
    KNOWLEDGE_CONTRACT,
    `\nYou are ONE worker in a partitioned swarm; other workers cover the rest of
the repository. Your slice is the complete list below — cite ONLY these files.
You may also emit an optional free-text 'hint' per statement: context a
cross-slice synthesizer might need (a suspicion that a pattern continues
elsewhere, a coupling you cannot see the other end of). Hints are discarded
after synthesis — never facts, never stored.`,
    `\nYOUR SLICE (${slice.files.length} files at base ${snapshot.baseOid.slice(0, 12)}):\n${paths}`,
    "\nEmit the knowledge statements for this slice.",
  ].join("\n");
}

/**
 * Run one partition worker over its slice. Anchors resolve against the WHOLE
 * snapshot inventory (the honesty authority); the prompt constrains citations
 * to the slice. No budget parameter — the map path is uncapped by decision.
 */
export async function runPartitionWorker(
  input: PartitionWorkerInput,
): Promise<PartitionWorkerResult> {
  const { slice, snapshot, provenance, runTurn, maxRetries = 1 } = input;
  const generator = provenance.generator ?? KNOWLEDGE_SWARM_GENERATOR_ID;
  const filesByPath = fileBlobIndex(snapshot.files);
  const prompt = buildWorkerPrompt(slice, snapshot);
  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };
  let lastFailure = "the partition worker did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    const statements: WorkerStatement[] = [];
    for (const raw of parseStatements(turn.body)) {
      const minted = mintStatement(raw, filesByPath, snapshot, provenance, generator, tally);
      if (minted === undefined) continue;
      const hint = (raw as Record<string, unknown>).hint;
      statements.push({
        statement: minted,
        ...(typeof hint === "string" && hint.length > 0 ? { hint } : {}),
      });
    }
    return {
      sliceId: slice.id,
      status: "ok",
      statements,
      droppedAnchors: tally.droppedAnchors,
      droppedStatements: tally.droppedStatements,
      attempts: attempt + 1,
    };
  }
  return {
    sliceId: slice.id,
    status: "failed",
    failureReason: lastFailure,
    statements: [],
    droppedAnchors: tally.droppedAnchors,
    droppedStatements: tally.droppedStatements,
    attempts: maxRetries + 1,
  };
}

// ── Verify / synthesis seat ──────────────────────────────────────────────────

/**
 * The verify seat's output schema: a verdict per reviewed hypothesis (by
 * statement id) plus cross-cutting statements in the shared statement contract.
 */
export const MAP_VERIFY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts", "crossCutting"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict"],
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["confirmed", "rejected"] },
        },
      },
    },
    crossCutting: KNOWLEDGE_OUTPUT_SCHEMA.properties.statements,
  },
} as const;

export interface MapVerifyInput {
  readonly workerResults: readonly PartitionWorkerResult[];
  readonly snapshot: KnowledgeSnapshotContext;
  readonly provenance: KnowledgeProvenanceSeed;
  readonly runTurn: RunTurn;
  readonly maxRetries?: number;
}

export interface MapVerifyResult {
  readonly status: "ok" | "failed";
  readonly failureReason?: string;
  /** The synthesized set, present on `ok`: verified worker statements + cross-cutting mints, deduped. */
  readonly set?: KnowledgeSet;
  /** How many hypotheses the seat confirmed / rejected (rejected stay in the set as recorded state). */
  readonly confirmed: number;
  readonly rejected: number;
  /** Cross-cutting statements minted by the seat (hypothesis-labelled — nothing has verified THEM). */
  readonly crossCutting: number;
  readonly droppedAnchors: number;
  readonly droppedStatements: number;
}

function renderHypothesis(entry: WorkerStatement): string {
  const s = entry.statement;
  const anchors = s.evidence
    .map((a) => {
      const span = a.lines
        ? `:${a.lines.startLine}${a.lines.endLine !== undefined ? `-${a.lines.endLine}` : ""}`
        : "";
      return `${a.path}${span}${a.symbol ? ` (${a.symbol})` : ""}`;
    })
    .join(", ");
  const hint = entry.hint ? `\n  hint: ${entry.hint}` : "";
  return `- id=${s.id}\n  [${s.aspect}/${s.confidence}] ${s.subject}: ${s.claim}\n  evidence: ${anchors}${hint}`;
}

function buildVerifyPrompt(
  entries: readonly WorkerStatement[],
  snapshot: KnowledgeSnapshotContext,
): string {
  return [
    KNOWLEDGE_CONTRACT,
    `\nYou are the VERIFY/SYNTHESIS seat over a partitioned worker swarm. Below are
the workers' hypothesis statements with their evidence anchors (and discardable
worker hints). For EACH hypothesis: re-read ONLY the cited spans (the anchors
bound your reading — this is not a repository re-read) and give a verdict:
'confirmed' when the cited code supports the claim, 'rejected' when it does
not. Then mint the CROSS-CUTTING statements no single worker could see
(patterns spanning slices), obeying the same evidence rules — cite only paths
from the file inventory you have seen in the cited spans.`,
    `\nHYPOTHESES (base ${snapshot.baseOid.slice(0, 12)}):\n${entries.map(renderHypothesis).join("\n")}`,
    "\nEmit your verdicts and cross-cutting statements.",
  ].join("\n");
}

/**
 * Run the verify/synthesis seat: flips each worker hypothesis to `confirmed` or
 * `rejected` per the seat's span-bounded re-read (an id without a verdict stays
 * an honest `hypothesis`), mints the seat's cross-cutting statements through
 * the same honesty contract (they enter as hypotheses — nothing has verified
 * them), dedups by statement id, and returns the `KnowledgeSet`. Human confirm
 * remains an optional override elsewhere — never a gate here.
 */
export async function runMapVerify(input: MapVerifyInput): Promise<MapVerifyResult> {
  const { workerResults, snapshot, provenance, runTurn, maxRetries = 1 } = input;
  const generator = provenance.generator ?? KNOWLEDGE_SWARM_GENERATOR_ID;
  const filesByPath = fileBlobIndex(snapshot.files);
  const entries = workerResults.flatMap((result) => result.statements);
  const byId = new Map(entries.map((entry) => [entry.statement.id, entry.statement]));
  const prompt = buildVerifyPrompt(entries, snapshot);
  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };
  let lastFailure = "the map verify pass did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    const body = (turn.body ?? {}) as Record<string, unknown>;
    let confirmed = 0;
    let rejected = 0;
    const verdicts = Array.isArray(body.verdicts) ? body.verdicts : [];
    for (const raw of verdicts) {
      if (!raw || typeof raw !== "object") continue;
      const { id, verdict } = raw as Record<string, unknown>;
      if (typeof id !== "string" || (verdict !== "confirmed" && verdict !== "rejected")) continue;
      const statement = byId.get(id);
      if (statement === undefined) continue; // A verdict on an id the swarm never minted is noise.
      byId.set(id, { ...statement, status: verdict });
      if (verdict === "confirmed") confirmed += 1;
      else rejected += 1;
    }
    const crossCutting = (Array.isArray(body.crossCutting) ? body.crossCutting : [])
      .map((raw) => mintStatement(raw, filesByPath, snapshot, provenance, generator, tally))
      .filter((s): s is KnowledgeStatement => s !== undefined);
    const set: KnowledgeSet = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      repoKey: snapshot.repoKey,
      baseOid: snapshot.baseOid,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      generator,
      statements: dedupById([...byId.values(), ...crossCutting]),
    };
    return {
      status: "ok",
      set,
      confirmed,
      rejected,
      crossCutting: crossCutting.length,
      droppedAnchors: tally.droppedAnchors,
      droppedStatements: tally.droppedStatements,
    };
  }
  return {
    status: "failed",
    failureReason: lastFailure,
    confirmed: 0,
    rejected: 0,
    crossCutting: 0,
    droppedAnchors: tally.droppedAnchors,
    droppedStatements: tally.droppedStatements,
  };
}
