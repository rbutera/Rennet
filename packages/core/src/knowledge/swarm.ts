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
import { mergeWorkerResults } from "./merge";
import type { KnowledgeProvenanceSeed, KnowledgeSnapshotContext } from "./mint";
import {
  dedupById,
  KNOWLEDGE_CONTRACT,
  KNOWLEDGE_OUTPUT_SCHEMA,
  type MintTally,
  mintStatement,
  parseStatements,
} from "./mint";
import type { FileEntry, PartitionSlice, SliceImport } from "./partition";
import { fileBlobIndex } from "./read";

/**
 * The swarm generator identity: bump on any prompt/schema change.
 *
 * `@2` is the context-map rebuild's W3 rework — skeleton-fed worker packets, the
 * deterministic merge, and a verify seat that sees only the residue. A `@1` set is a
 * different pipeline's output and is replaced rather than carried, and a `@1`
 * journal entry is refused rather than reused (it is part of the journal's target
 * key), so the rework cannot inherit answers to the questions it stopped asking.
 */
export const KNOWLEDGE_SWARM_GENERATOR_ID = "knowledge-swarm@2";

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

/**
 * One file's line in the packet: its path, then its declared top-level symbols.
 *
 * The three cases are three different facts and the packet says which:
 *  - symbols present and non-empty → the skeleton, `name (kind) L<line>`;
 *  - symbols present and EMPTY → indexed, declares nothing (a `.md`, a `.json`);
 *  - symbols ABSENT → no symbol index covers this file.
 *
 * A `.md` has no structure to show, so the packet says it has none. Rendering an
 * empty symbol list identically to an unindexed one would let a worker read
 * "nothing here" off a file nothing ever looked at.
 */
function renderFileSkeleton(file: FileEntry): string {
  if (file.symbols === undefined) return `- ${file.path}\n    (no symbol index for this file)`;
  if (file.symbols.length === 0)
    return `- ${file.path}\n    (indexed; declares no top-level symbols)`;
  const symbols = file.symbols
    .map((symbol) => `    ${symbol.name} (${symbol.kind}) L${symbol.line}`)
    .join("\n");
  return `- ${file.path}\n${symbols}`;
}

/** The slice's own resolved import edges, or the honest reason there are none to show. */
function renderSliceImports(slice: PartitionSlice): string {
  if (slice.imports === undefined) {
    return "\nIMPORTS WITHIN THIS SLICE: the import graph could not be read for this\nrun, so nothing is listed here. Absence below is not evidence of absence.";
  }
  if (slice.imports.length === 0) {
    return "\nIMPORTS WITHIN THIS SLICE: none. No resolved import edge joins any two of\nthese files — that is why they are grouped by location rather than by module.";
  }
  const lines = slice.imports.map((edge) => `- ${edge.from} -> ${edge.to}`).join("\n");
  return `\nIMPORTS WITHIN THIS SLICE (${slice.imports.length} resolved edges):\n${lines}`;
}

/** The edges batching cut: each member's 1-hop neighbours outside the slice. */
function renderNeighbors(slice: PartitionSlice): string {
  if (slice.neighbors.length === 0) {
    return "\nNEIGHBOURS OUTSIDE THIS SLICE: none recorded.";
  }
  const lines = slice.neighbors
    .map((member) => {
      const neighbors = member.neighbors
        .map(
          (neighbor) =>
            `    ${neighbor.direction} ${neighbor.path}${
              neighbor.symbols.length === 0 ? "" : ` [exports: ${neighbor.symbols.join(", ")}]`
            }`,
        )
        .join("\n");
      const more = member.truncated > 0 ? `\n    (+${member.truncated} more, not shown)` : "";
      return `- ${member.path}\n${neighbors}${more}`;
    })
    .join("\n");
  return `\nNEIGHBOURS OUTSIDE THIS SLICE (the import edges this partitioning cut —
'imports' / 'imported-by' / 'both' is from YOUR file's point of view; the
neighbour itself belongs to another worker's slice, so do not claim things about
it, but do use it to understand yours):\n${lines}`;
}

function buildWorkerPrompt(slice: PartitionSlice, snapshot: KnowledgeSnapshotContext): string {
  const skeletons = slice.files.map(renderFileSkeleton).join("\n");
  return [
    KNOWLEDGE_CONTRACT,
    `\nYou are ONE worker in a partitioned swarm; other workers cover the rest of
the repository. Your slice is the complete list below — cite ONLY these files.
You may also emit an optional free-text 'hint' per statement: context a
cross-slice synthesizer might need (a suspicion that a pattern continues
elsewhere, a coupling you cannot see the other end of). Hints are discarded
after synthesis — never facts, never stored.`,
    `\nYOUR SLICE (${slice.files.length} files at base ${snapshot.baseOid.slice(0, 12)}),
with each file's declared top-level symbols:\n${skeletons}`,
    renderSliceImports(slice),
    renderNeighbors(slice),
    `\nHOW TO WORK: everything above is deterministic — extracted from the
repository, not guessed — so start there and let it tell you where to look. Your
working directory IS the repository checkout and you are FREE to read any of it;
reading is targeted, not forbidden. Read the source when the skeleton cannot
answer your question, which is most of the time for a WHY. What you must not do
is claim from a filename: evidence means code you actually read.`,
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
  /** The slices the workers ran, for the merge pass's seam detection. */
  readonly slices?: readonly PartitionSlice[];
  /** The authoritative repo-wide import edges, when the graph was readable. */
  readonly importEdges?: readonly SliceImport[];
  /** A delta's prior statements whose cited evidence changed — judgment, not mechanics. */
  readonly reverify?: readonly KnowledgeStatement[];
  readonly snapshot: KnowledgeSnapshotContext;
  readonly provenance: KnowledgeProvenanceSeed;
  readonly runTurn: RunTurn;
  readonly maxRetries?: number;
  /** Residue entries per verify turn. Default `MAP_VERIFY_CHUNK_SIZE`. */
  readonly chunkSize?: number;
  /** Concurrent verify turns. Default {@link MAP_VERIFY_CONCURRENCY}. */
  readonly concurrency?: number;
}

/**
 * Residue entries per verify turn. A ceiling, not the expected size: since W3 the
 * seat receives only the deterministic pass's RESIDUE (cross-batch seams and flagged
 * contradictions), not every hypothesis the swarm minted, so on a real repository
 * the residue is normally one chunk or two.
 *
 * The number is inherited from the shape that broke: the seat used to receive EVERY
 * partition's statements in one prompt — Rennet itself, 199 partitions, ~1,900
 * statements — which exceeded the harness context window, died with "Prompt is too
 * long", and discarded the whole run. 150 renders to roughly 12k tokens, well inside
 * any seat, and remains the hard bound if a repository ever produces a residue that
 * large.
 */
export const MAP_VERIFY_CHUNK_SIZE = 150;

/**
 * Concurrent verify turns. Lower than either harness's partition-worker fan-out
 * policy on purpose: a verify turn re-reads cited spans and carries a larger prompt,
 * and there are only ever a handful of them now that the seat sees the residue
 * rather than the whole set.
 */
export const MAP_VERIFY_CONCURRENCY = 4;

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
  /** The synthesized set, present on `ok`: merged worker statements + cross-cutting mints, deduped. */
  readonly set?: KnowledgeSet;
  /** How many hypotheses the seat confirmed / rejected (rejected stay in the set as recorded state). */
  readonly confirmed: number;
  readonly rejected: number;
  /** Cross-cutting statements minted by the seat (hypothesis-labelled — nothing has verified THEM). */
  readonly crossCutting: number;
  readonly droppedAnchors: number;
  readonly droppedStatements: number;
  /**
   * What the deterministic pass did, and how much of it the seat had to see.
   * `residue / merged` is the measurement the W3 redesign exists to move: it used to
   * be 1.0 by construction, which is the ratio that overflowed the seat.
   */
  readonly merged: number;
  readonly residue: number;
  readonly duplicateIds: number;
  readonly duplicateClaims: number;
  readonly flagged: number;
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

/** One residue entry: a seam candidate, or a flagged statement with its reason. */
type ResidueEntry = { readonly entry: WorkerStatement; readonly flagReason?: string };

function renderResidue(residue: ResidueEntry): string {
  const base = renderHypothesis(residue.entry);
  return residue.flagReason === undefined ? base : `${base}\n  FLAGGED: ${residue.flagReason}`;
}

function buildVerifyPrompt(
  entries: readonly ResidueEntry[],
  snapshot: KnowledgeSnapshotContext,
): string {
  const flagged = entries.filter((residue) => residue.flagReason !== undefined).length;
  const seams = entries.length - flagged;
  return [
    KNOWLEDGE_CONTRACT,
    `\nYou are the VERIFY/SYNTHESIS seat over a partitioned worker swarm. A
deterministic merge pass has ALREADY run: it collapsed duplicate claims, checked
every import-shaped claim against the repository's own import index, and dropped
what would not anchor. You are NOT being asked to re-adjudicate the swarm — most
of its statements are settled and are not shown to you. What is below is the
residue that a script cannot settle.

Two kinds, and they want different things from you:

1. SEAM statements (${seams} below, unflagged). These sit on an import edge that
   the partitioning CUT, and the file on the other side of that edge carries
   claims from a DIFFERENT worker. No single worker could see both halves. Read
   them together and mint the CROSS-CUTTING statements that only exist when they
   are read together. Do not restate a claim already listed — it is already
   recorded. Leave these unverdicted unless you positively disprove one.

2. FLAGGED statements (${flagged} below, each with a FLAGGED: line). The script
   found something it could not settle and needs your judgment. Re-read the cited
   spans and give a verdict: 'confirmed' when the cited code supports the claim,
   'rejected' when it does not.

Your working directory is the repository checkout; the anchors below tell you
where to look first, and you may read further when that is what it takes to know.
Mint only what you can anchor to a path in the inventory you have actually read.`,
    `\nRESIDUE (base ${snapshot.baseOid.slice(0, 12)}):\n${entries.map(renderResidue).join("\n")}`,
    "\nEmit your verdicts and cross-cutting statements.",
  ].join("\n");
}

/** One line per chunk: what it covered, without repeating a single hypothesis. */
function chunkDigest(
  entries: readonly ResidueEntry[],
  result: VerifyChunkOk,
  index: number,
): string {
  const confirmed = result.verdicts.filter((v) => v.verdict === "confirmed").length;
  const subjects = [...new Set(entries.map((residue) => residue.entry.statement.subject))];
  const shown = subjects.slice(0, CROSS_BOUNDARY_SUBJECTS_PER_CHUNK);
  const more = subjects.length - shown.length;
  return `- chunk ${index + 1}: ${entries.length} residue entries, ${confirmed} confirmed, ${
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
 * Merge the workers' outputs deterministically, then run the verify/synthesis seat
 * over WHAT IS LEFT.
 *
 * The merge ({@link mergeWorkerResults}) is a script: it collapses duplicate ids and
 * duplicate claims, and checks import-shaped claims against the authoritative edge
 * shard. What survives keeps the WORKER's provenance, untouched — the merge does not
 * mint, so nothing in it can claim to have been model-verified when it was not.
 *
 * The seat then receives only the RESIDUE: the cross-batch seams (a claim on one end
 * of a cut import edge whose other end another batch also claimed) and the flagged
 * contradictions. It does not re-adjudicate settled statements. That is the whole
 * structural change: the old seat's input was every hypothesis the swarm minted, and
 * on a real repository that prompt did not fit in any context window.
 *
 * An EMPTY residue runs no turn at all. With no seam and no contradiction there is
 * nothing for the seat to synthesize from, and a turn over an empty prompt is a seat
 * inventing claims with no material — the exact failure the anchor rules exist to
 * stop. `crossCutting: 0` is then the honest answer, not a skipped step.
 *
 * Verdicts flip a statement to `confirmed` / `rejected`; an id without a verdict
 * stays an honest `hypothesis`. Cross-cutting mints carry the VERIFY seat's
 * provenance and enter as hypotheses — nothing has verified them. Human confirm
 * remains an optional override elsewhere, never a gate here.
 */
export async function runMapVerify(input: MapVerifyInput): Promise<MapVerifyResult> {
  const {
    workerResults,
    snapshot,
    provenance,
    runTurn,
    maxRetries = 1,
    chunkSize = MAP_VERIFY_CHUNK_SIZE,
    concurrency = MAP_VERIFY_CONCURRENCY,
  } = input;
  const generator = provenance.generator ?? KNOWLEDGE_SWARM_GENERATOR_ID;
  const filesByPath = fileBlobIndex(snapshot.files);
  const merge = mergeWorkerResults({
    workerResults,
    slices: input.slices ?? [],
    snapshot,
    ...(input.importEdges === undefined ? {} : { importEdges: input.importEdges }),
    ...(input.reverify === undefined ? {} : { reverify: input.reverify }),
  });
  const byId = new Map(merge.statements.map((statement) => [statement.id, statement]));
  const tally: MintTally = { droppedAnchors: 0, droppedStatements: 0 };

  // The residue, deduped by id: a statement can be BOTH a seam and flagged, and
  // sending it twice would let two chunks return conflicting verdicts on one id —
  // whichever landed later silently overwriting the other.
  const residueById = new Map<string, ResidueEntry>();
  for (const entry of merge.seams) residueById.set(entry.statement.id, { entry });
  for (const flag of merge.flagged) {
    residueById.set(flag.statement.id, {
      entry: {
        statement: flag.statement,
        ...(flag.hint === undefined ? {} : { hint: flag.hint }),
      },
      flagReason: flag.reason,
    });
  }
  const residue = [...residueById.values()];

  const counts = {
    merged: merge.statements.length,
    residue: residue.length,
    duplicateIds: merge.duplicateIds,
    duplicateClaims: merge.duplicateClaims,
    flagged: merge.flagged.length,
  } as const;

  if (residue.length === 0) {
    return {
      status: "ok",
      set: {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        repoKey: snapshot.repoKey,
        baseOid: snapshot.baseOid,
        snapshotFingerprint: snapshot.snapshotFingerprint,
        generator,
        statements: dedupById(merge.statements),
      },
      confirmed: 0,
      rejected: 0,
      crossCutting: 0,
      droppedAnchors: 0,
      droppedStatements: 0,
      ...counts,
    };
  }

  // One prompt per chunk. `chunkSize` is a ceiling the residue is not expected to
  // reach; it stays because a repository that DOES produce a large residue must not
  // rediscover the unbounded prompt.
  const chunks: ResidueEntry[][] = [];
  for (let start = 0; start < residue.length; start += Math.max(1, chunkSize)) {
    chunks.push(residue.slice(start, start + Math.max(1, chunkSize)));
  }

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
        ...counts,
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
  // BOUNDED BY CONSTRUCTION — do not "improve" this into a pass over the merged
  // statements, which is exactly the unbounded prompt that killed whole runs.
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
    ...counts,
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
