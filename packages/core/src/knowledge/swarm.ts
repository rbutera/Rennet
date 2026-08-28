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
import type { KnowledgeProvenanceSeed, KnowledgeSnapshotContext } from "./mint";
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
    `\nYour working directory is the repository checkout. READ the slice files
themselves before making claims — evidence means the code you actually read,
never a guess from a filename.`,
    "\nEmit the knowledge statements for this slice.",
  ].join("\n");
}

/**
 * Run one partition worker over its slice. Anchors resolve against the SLICE's
 * file index only — off-slice citations are dropped by the same anchor-or-drop
 * rule as invented paths, so partition isolation is enforced at mint time, not
 * merely requested in the prompt. No budget parameter — the map path is
 * uncapped by decision.
 */
export async function runPartitionWorker(
  input: PartitionWorkerInput,
): Promise<PartitionWorkerResult> {
  const { slice, snapshot, provenance, runTurn, maxRetries = 1 } = input;
  const generator = provenance.generator ?? KNOWLEDGE_SWARM_GENERATOR_ID;
  const filesByPath = fileBlobIndex(slice.files);
  const prompt = buildWorkerPrompt(slice, snapshot);
  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };
  let lastFailure = "the partition worker did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    // Provenance names what ACTUALLY ran when the turn reported it (review P2).
    const observed: KnowledgeProvenanceSeed = {
      model: turn.observed?.model ?? provenance.model,
      apiKeySource: turn.observed?.apiKeySource ?? provenance.apiKeySource,
      ...(provenance.generator === undefined ? {} : { generator: provenance.generator }),
    };
    const statements: WorkerStatement[] = [];
    for (const raw of parseStatements(turn.body)) {
      const minted = mintStatement(raw, filesByPath, snapshot, observed, generator, tally);
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
  /** Hypotheses per verify turn. Default `MAP_VERIFY_CHUNK_SIZE`. */
  readonly chunkSize?: number;
  /** Concurrent verify turns. Default 4 (the swarm's worker default). */
  readonly concurrency?: number;
}

/**
 * Hypotheses per verify turn. The seat used to receive EVERY partition's
 * statements in one prompt, which on a real repository (Rennet itself: 199
 * partitions, ~1900 statements) exceeded the harness context window — the seat
 * died with "Prompt is too long" and the whole run's statements were discarded.
 * 150 renders to roughly 12k tokens of hypothesis list, well inside any seat.
 *
 * Chunking bounds what one turn can synthesize, so `runCrossBoundarySynthesis`
 * runs a second pass over the chunks' OUTPUTS to reach across the boundaries.
 */
export const MAP_VERIFY_CHUNK_SIZE = 150;

/** Run `tasks` with at most `limit` in flight (order of completion is irrelevant). */
export async function boundedAll<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task) results[index] = await task();
    }
  });
  await Promise.all(lanes);
  return results;
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

/** One line per chunk: what it covered, without repeating a single hypothesis. */
function chunkDigest(
  entries: readonly WorkerStatement[],
  result: VerifyChunkOk,
  index: number,
): string {
  const confirmed = result.verdicts.filter((v) => v.verdict === "confirmed").length;
  const subjects = [...new Set(entries.map((entry) => entry.statement.subject))];
  const shown = subjects.slice(0, CROSS_BOUNDARY_SUBJECTS_PER_CHUNK);
  const more = subjects.length - shown.length;
  return `- chunk ${index + 1}: ${entries.length} hypotheses, ${confirmed} confirmed, ${
    result.verdicts.length - confirmed
  } rejected; subjects: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * Distinct subjects named per chunk in the cross-boundary digest. The digest is
 * O(chunks), never O(statements) — that is the whole point of it.
 */
const CROSS_BOUNDARY_SUBJECTS_PER_CHUNK = 12;

function buildCrossBoundaryPrompt(
  candidates: readonly KnowledgeStatement[],
  digests: readonly string[],
  snapshot: KnowledgeSnapshotContext,
): string {
  const rendered = candidates.map((statement) =>
    renderHypothesis({ statement } satisfies WorkerStatement),
  );
  return [
    KNOWLEDGE_CONTRACT,
    `\nYou are the CROSS-BOUNDARY synthesis seat. The verify seat read the
repository's hypotheses in ${digests.length} separate turns, so no single turn
could see a pattern whose evidence lay in two different turns. Below are the
cross-cutting claims each of those turns produced, plus a one-line summary of
what each turn covered.

Mint ONLY the statements that span these turns — a pattern visible when two of
the claims below are read together and invisible in either alone. Do not restate
a claim that is already listed; it is already recorded. Obey the same evidence
rules: re-read the cited spans and cite only paths you have seen there. Emit an
empty 'verdicts' array — this seat mints, it does not re-adjudicate.`,
    `\nWHAT EACH VERIFY TURN COVERED:\n${digests.join("\n")}`,
    `\nTHEIR CROSS-CUTTING CLAIMS (base ${snapshot.baseOid.slice(0, 12)}):\n${rendered.join("\n")}`,
    "\nEmit the cross-boundary statements, or none if the claims do not connect.",
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
  const {
    workerResults,
    snapshot,
    provenance,
    runTurn,
    maxRetries = 1,
    chunkSize = MAP_VERIFY_CHUNK_SIZE,
    concurrency = 4,
  } = input;
  const generator = provenance.generator ?? KNOWLEDGE_SWARM_GENERATOR_ID;
  const filesByPath = fileBlobIndex(snapshot.files);
  // Dedupe BEFORE chunking, not just into `byId`: the same statement id can be
  // minted by two partitions (the delta path also feeds `prior:reverify`
  // alongside a fresh run of the slice that owns it). Chunking the raw entries
  // put one id in two chunks, which could return conflicting verdicts — and the
  // later chunk's verdict silently overwrote the earlier one.
  const entriesById = new Map<string, WorkerStatement>();
  for (const result of workerResults)
    for (const entry of result.statements)
      if (!entriesById.has(entry.statement.id)) entriesById.set(entry.statement.id, entry);
  const entries = [...entriesById.values()];
  const byId = new Map(entries.map((entry) => [entry.statement.id, entry.statement]));
  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };

  // One prompt per chunk: the seat's context is finite and the whole swarm's
  // statements do not fit in it. An empty swarm still runs one turn — the seat
  // can mint cross-cutting statements with no hypotheses to adjudicate.
  const chunks: (readonly WorkerStatement[])[] = [];
  for (let start = 0; start < entries.length; start += Math.max(1, chunkSize)) {
    chunks.push(entries.slice(start, start + Math.max(1, chunkSize)));
  }
  if (chunks.length === 0) chunks.push([]);

  // The pass is all-or-nothing, so once one chunk has failed the verdict is
  // already decided and every chunk still queued is discarded model spend.
  let firstFailure: string | undefined;
  const chunkResults = await boundedAll(
    chunks.map((chunk) => async (): Promise<VerifyChunkResult> => {
      if (firstFailure !== undefined) return { status: "failed", failureReason: firstFailure };
      const result = await runVerifyChunk({
        prompt: buildVerifyPrompt(chunk, snapshot),
        snapshot,
        provenance,
        generator,
        filesByPath,
        tally,
        runTurn,
        maxRetries,
      });
      if (result.status === "failed") firstFailure ??= result.failureReason;
      return result;
    }),
    concurrency,
  );

  const okChunks: VerifyChunkOk[] = [];
  for (const result of chunkResults) {
    // All-or-nothing, as before: a partial verify would silently publish an
    // unadjudicated slice of the repository as if the seat had seen it.
    if (result.status === "failed") {
      return {
        status: "failed",
        failureReason: result.failureReason,
        confirmed: 0,
        rejected: 0,
        crossCutting: 0,
        droppedAnchors: tally.droppedAnchors,
        droppedStatements: tally.droppedStatements,
      };
    }
    okChunks.push(result);
  }

  let confirmed = 0;
  let rejected = 0;
  for (const result of okChunks) {
    for (const { id, verdict } of result.verdicts) {
      const statement = byId.get(id);
      if (statement === undefined) continue; // A verdict on an id the swarm never minted is noise.
      byId.set(id, { ...statement, status: verdict });
      if (verdict === "confirmed") confirmed += 1;
      else rejected += 1;
    }
  }
  const chunkCrossCutting = okChunks.flatMap((result) => result.crossCutting);
  // The second pass (#591): chunking cost the seat any pattern whose two halves
  // landed in different turns, and the map lost it silently. This turn reaches
  // across those boundaries.
  //
  // BOUNDED BY CONSTRUCTION — do not "improve" this into a pass over the raw
  // hypotheses, which is exactly the unbounded prompt that killed whole runs.
  // Its input is the chunks' OUTPUTS: O(chunks) digest lines plus the handful of
  // cross-cutting claims each turn minted, never the ~1900 statements. The
  // `chunkSize` slice is a hard ceiling on top of that, so this prompt cannot
  // grow past a single verify chunk's proven-safe size no matter how large the
  // repository is.
  const candidates = chunkCrossCutting.slice(0, Math.max(1, chunkSize));
  const crossBoundary =
    okChunks.length > 1 && candidates.length > 0
      ? await runVerifyChunk({
          prompt: buildCrossBoundaryPrompt(
            candidates,
            okChunks.map((result, index) => chunkDigest(chunks[index] ?? [], result, index)),
            snapshot,
          ),
          snapshot,
          provenance,
          generator,
          filesByPath,
          tally,
          runTurn,
          maxRetries,
        })
      : null;
  // Best-effort: a failed second pass keeps the chunk-local synthesis rather
  // than discarding a whole good run over a bonus turn.
  const crossCutting =
    crossBoundary?.status === "ok"
      ? [...chunkCrossCutting, ...crossBoundary.crossCutting]
      : chunkCrossCutting;
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

interface VerifyChunkInput {
  /** The rendered prompt — a hypothesis chunk, or the cross-boundary pass's. */
  readonly prompt: string;
  readonly snapshot: KnowledgeSnapshotContext;
  readonly provenance: KnowledgeProvenanceSeed;
  readonly generator: string;
  readonly filesByPath: ReturnType<typeof fileBlobIndex>;
  readonly tally: MintTally;
  readonly runTurn: RunTurn;
  readonly maxRetries: number;
}

/**
 * A chunk either adjudicated or did not. The optional-`failureReason` shape this
 * replaced could represent a failure with no reason, an `ok` carrying one, and a
 * failure carrying meaningless empty verdict/cross-cutting arrays.
 */
type VerifyChunkResult =
  | {
      readonly status: "ok";
      readonly verdicts: readonly { id: string; verdict: "confirmed" | "rejected" }[];
      readonly crossCutting: readonly KnowledgeStatement[];
    }
  | { readonly status: "failed"; readonly failureReason: string };

type VerifyChunkOk = Extract<VerifyChunkResult, { status: "ok" }>;

/** One seat turn over one rendered prompt, with the seat's own retries. */
async function runVerifyChunk(input: VerifyChunkInput): Promise<VerifyChunkResult> {
  const { prompt, snapshot, provenance, generator, filesByPath, tally, runTurn, maxRetries } =
    input;
  let lastFailure = "the map verify pass did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const turn = await runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }
    const body = (turn.body ?? {}) as Record<string, unknown>;
    const verdicts: { id: string; verdict: "confirmed" | "rejected" }[] = [];
    for (const raw of Array.isArray(body.verdicts) ? body.verdicts : []) {
      if (!raw || typeof raw !== "object") continue;
      const { id, verdict } = raw as Record<string, unknown>;
      if (typeof id !== "string" || (verdict !== "confirmed" && verdict !== "rejected")) continue;
      verdicts.push({ id, verdict });
    }
    // Cross-cutting statements carry the VERIFIER's observed provenance (review P2).
    const observed: KnowledgeProvenanceSeed = {
      model: turn.observed?.model ?? provenance.model,
      apiKeySource: turn.observed?.apiKeySource ?? provenance.apiKeySource,
      ...(provenance.generator === undefined ? {} : { generator: provenance.generator }),
    };
    const crossCutting = (Array.isArray(body.crossCutting) ? body.crossCutting : [])
      .map((raw) => mintStatement(raw, filesByPath, snapshot, observed, generator, tally))
      .filter((s): s is KnowledgeStatement => s !== undefined);
    return { status: "ok", verdicts, crossCutting };
  }
  return { status: "failed", failureReason: lastFailure };
}
