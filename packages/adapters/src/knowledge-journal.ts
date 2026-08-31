import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  PartitionSlice,
  PartitionWorkerResult,
  WorkerCrossSliceHint,
  WorkerStatement,
} from "@rennet/core";
import { knowledgeStatementId, providerHarness, validateKnowledgeStatement } from "@rennet/core";
import type { CouncilResolution, KnowledgeStatement } from "@rennet/protocol";
import { canonicalize, councilEffortSchema, councilModelSchema, sha256Hex } from "@rennet/protocol";
import { z } from "zod";
import { writeAtomic } from "./knowledge-store";

/**
 * The per-batch results JOURNAL (#581).
 *
 * Before this, a swarm run had exactly ONE store write, after the verify seat
 * returned. On Rennet that meant ~200 worker turns, an hour of subscription, and a
 * single flaky worker throwing all of it away — including the 199 that had
 * succeeded. A crash was worse: nothing had been written anywhere, so a re-run
 * started from zero.
 *
 * A completed worker now writes its result here as it finishes. A re-run at the SAME
 * target reuses those results instead of re-running their turns, so a retry costs
 * only the batches that actually failed.
 *
 * ⛔ The journal is NOT the store, and this is the whole point of it being a separate
 * place. It lives beside `knowledge/` under the project's reserved directory, never
 * inside it, and no reader consults it. The P1 invariant holds unchanged: the live
 * `knowledge.json` is written once, when the set is WHOLE — a partial set never
 * presents as complete, however much of it is journaled. Promotion deletes the
 * journal; nothing else does.
 *
 * FAIL-SAFE throughout (Rule 75): an unreadable, malformed, foreign-target or
 * INTERNALLY INCONSISTENT entry reads as "not journaled", which costs one re-run
 * turn. It never throws, and it never lets a damaged statement into a set.
 *
 * ONE DIRECTORY PER TARGET. Entries are keyed by target, but they used to share a
 * flat directory and {@link KnowledgeJournal.clear} removed that directory whole —
 * so a run promoting at one baseline deleted a concurrently-running run's journal at
 * another, and the second run's completed turns were unrecoverable. Each target gets
 * its own subdirectory ({@link journalTargetDir}, over the target IN FULL — a
 * directory named for the base OID alone put a re-extraction and a prompt rework at
 * that same OID in one place, so promoting either deleted the other's completed
 * turns, which is the original bug at a finer grain), `clear` touches only its own,
 * and stale target directories are swept by AGE on promotion (see
 * {@link STALE_TARGET_AGE_MS}) rather than by guessing which of them is still live.
 *
 * The move to per-target directories ORPHANED every journal entry written under the
 * old FLAT layout, and deliberately: nothing reads them, so a run in flight across
 * the change re-runs its completed turns, once. Those loose files also outlive the
 * age sweep, which walks directory entries only (`entry.isDirectory()`) — they are
 * inert bytes under the project's reserved directory, costing disk and never
 * correctness, and the alternative was a reader for a layout nothing writes.
 *
 * ONE GAP, stated rather than defended: nothing here is atomic ACROSS the
 * journal-write / store-rename / journal-clear sequence, so a process death between
 * the store rename and the clear leaves a journal for a target already promoted. The
 * cost is bounded and one-directional — the next run at that target reuses results
 * for a set that is already correct, and the age sweep removes the directory later.
 * The store write itself is a single atomic rename, so no partial set can ever
 * present as whole, which is the property that actually matters.
 */

/** The journal directory name, sibling to `knowledge/` inside the project's store dir. */
export const KNOWLEDGE_JOURNAL_DIR = "knowledge-journal";

/** The one selector plan inside a target journal; never counted as a worker result. */
export const KNOWLEDGE_SCOPE_PLAN_FILE = "scope-plan.json";

/**
 * How long a FOREIGN target's journal directory must have sat untouched before a
 * promotion sweeps it. A day, because a live run writes into its own directory as
 * each batch finishes, so anything older than that belongs to a run that is over.
 *
 * ponytail: age, not liveness. A lock file or a pid registry would answer exactly,
 * and would be a coordination mechanism to maintain for a few megabytes of temp
 * files. Tighten it if a real run is ever measured taking a day.
 */
export const STALE_TARGET_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * What a journaled result was produced FOR. All three fields, because a batch's
 * output is only reusable when every input that shaped it is unchanged:
 *
 *  - `baseOid` — the code the worker read.
 *  - `snapshotFingerprint` — the extracted view of it. A re-extraction at the same
 *    git OID (a new symbol or import extractor) changes what the packet said, so the
 *    old answer was to a different question.
 *  - `generator` — the prompt and merge contract itself. Bumping
 *    `KNOWLEDGE_SWARM_GENERATOR_ID` is how a prompt rework invalidates every
 *    journaled result at an unchanged baseline; without it in the key, a reworked
 *    swarm would happily reuse the old swarm's answers.
 */
export interface JournalTarget {
  readonly baseOid: string;
  readonly snapshotFingerprint: string;
  readonly generator: string;
}

/** The model-council identity that produced one scope decision. */
export type ScopePlanResolvedAssignment = Readonly<
  Pick<Extract<CouncilResolution, { readonly kind: "model" }>, "harness" | "model" | "effort">
>;

/**
 * Everything an adapter must know to decide whether a journaled scope plan answers
 * its current question. Candidate membership is checked but not persisted as a
 * second private-data copy: the included and excluded whole-slice ids exact-cover it.
 */
export interface ScopePlanJournalInput {
  readonly selectorGenerator: string;
  readonly catalogueDigest: string;
  readonly sliceCap: number;
  readonly candidateSliceIds: readonly string[];
  readonly assignment: ScopePlanResolvedAssignment;
}

/** One whole candidate slice the selector deliberately left out. */
export interface ScopePlanExclusion {
  readonly sliceId: string;
  readonly reason: string;
}

/** The checked selector decision an adapter can replay without another model turn. */
export interface ScopePlanJournalResult {
  readonly includedSliceIds: readonly string[];
  readonly excludedSlices: readonly ScopePlanExclusion[];
  readonly provenance: KnowledgeStatement["provenance"];
}

const scopePlanTextSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());
const scopePlanAssignmentSchema = z
  .object({
    harness: z.enum(["claude-code", "codex"]),
    model: councilModelSchema,
    effort: councilEffortSchema,
  })
  .strict()
  .refine((assignment) => providerHarness(assignment.model) === assignment.harness);
const scopePlanInputSchema = z
  .object({
    selectorGenerator: scopePlanTextSchema,
    catalogueDigest: scopePlanTextSchema,
    sliceCap: z.number().int().positive(),
    candidateSliceIds: z.array(scopePlanTextSchema).min(1),
    assignment: scopePlanAssignmentSchema,
  })
  .strict()
  .refine((input) => new Set(input.candidateSliceIds).size === input.candidateSliceIds.length);
const scopePlanExclusionSchema = z
  .object({ sliceId: scopePlanTextSchema, reason: scopePlanTextSchema })
  .strict();
const scopePlanProvenanceSchema = z
  .object({
    generator: scopePlanTextSchema,
    model: scopePlanTextSchema.nullable(),
    apiKeySource: scopePlanTextSchema.nullable(),
  })
  .strict();
const scopePlanResultSchema = z
  .object({
    includedSliceIds: z.array(scopePlanTextSchema).min(1),
    excludedSlices: z.array(scopePlanExclusionSchema),
    provenance: scopePlanProvenanceSchema,
  })
  .strict();

const SCOPE_PLAN_SCHEMA_VERSION = 1;

interface ScopePlanRecordBody {
  readonly schemaVersion: 1;
  readonly target: JournalTarget;
  readonly selectorGenerator: string;
  readonly catalogueDigest: string;
  readonly sliceCap: number;
  readonly assignment: ScopePlanResolvedAssignment;
  readonly includedSliceIds: readonly string[];
  readonly excludedSlices: readonly ScopePlanExclusion[];
  readonly provenance: KnowledgeStatement["provenance"];
}

interface ScopePlanRecord extends ScopePlanRecordBody {
  readonly checksum: string;
}

const journalTargetSchema = z
  .object({
    baseOid: scopePlanTextSchema,
    snapshotFingerprint: scopePlanTextSchema,
    generator: scopePlanTextSchema,
  })
  .strict();
const scopePlanRecordBodySchema = z
  .object({
    schemaVersion: z.literal(SCOPE_PLAN_SCHEMA_VERSION),
    target: journalTargetSchema,
    selectorGenerator: scopePlanTextSchema,
    catalogueDigest: scopePlanTextSchema,
    sliceCap: z.number().int().positive(),
    assignment: scopePlanAssignmentSchema,
    includedSliceIds: z.array(scopePlanTextSchema).min(1),
    excludedSlices: z.array(scopePlanExclusionSchema),
    provenance: scopePlanProvenanceSchema,
  })
  .strict();
const scopePlanRecordSchema = scopePlanRecordBodySchema.extend({
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

function scopePlanChecksum(body: ScopePlanRecordBody): string {
  return sha256Hex(canonicalize(body));
}

function sameTarget(left: JournalTarget, right: JournalTarget): boolean {
  return (
    left.baseOid === right.baseOid &&
    left.snapshotFingerprint === right.snapshotFingerprint &&
    left.generator === right.generator
  );
}

function sameScopePlanIdentity(
  record: ScopePlanRecordBody,
  target: JournalTarget,
  input: ScopePlanJournalInput,
): boolean {
  return (
    sameTarget(record.target, target) &&
    record.selectorGenerator === input.selectorGenerator &&
    record.catalogueDigest === input.catalogueDigest &&
    record.sliceCap === input.sliceCap &&
    record.assignment.harness === input.assignment.harness &&
    record.assignment.model === input.assignment.model &&
    record.assignment.effort === input.assignment.effort
  );
}

/**
 * Check an untrusted plan against the current candidate catalogue, then put both
 * halves back into candidate order. The exact-cover check is what makes every id a
 * whole trusted slice, rather than model-authored path or prefix data in disguise.
 */
function checkedScopePlan(
  input: ScopePlanJournalInput,
  result: ScopePlanJournalResult,
): ScopePlanJournalResult | null {
  const parsedInput = scopePlanInputSchema.safeParse(input);
  const parsedResult = scopePlanResultSchema.safeParse(result);
  if (!parsedInput.success || !parsedResult.success) return null;
  if (parsedResult.data.provenance.generator !== parsedInput.data.selectorGenerator) return null;
  if (parsedResult.data.includedSliceIds.length > parsedInput.data.sliceCap) return null;

  const candidates = new Set(parsedInput.data.candidateSliceIds);
  const included = new Set(parsedResult.data.includedSliceIds);
  if (included.size !== parsedResult.data.includedSliceIds.length) return null;
  const exclusionById = new Map<string, string>();
  for (const exclusion of parsedResult.data.excludedSlices) {
    if (exclusionById.has(exclusion.sliceId)) return null;
    exclusionById.set(exclusion.sliceId, exclusion.reason);
  }
  if (included.size + exclusionById.size !== candidates.size) return null;
  for (const sliceId of included) {
    if (!candidates.has(sliceId) || exclusionById.has(sliceId)) return null;
  }
  for (const sliceId of exclusionById.keys()) {
    if (!candidates.has(sliceId)) return null;
  }

  return {
    includedSliceIds: parsedInput.data.candidateSliceIds.filter((sliceId) => included.has(sliceId)),
    excludedSlices: parsedInput.data.candidateSliceIds.flatMap((sliceId) => {
      const reason = exclusionById.get(sliceId);
      return reason === undefined ? [] : [{ sliceId, reason }];
    }),
    provenance: parsedResult.data.provenance,
  };
}

/** One journaled batch: exactly what `runPartitionWorker` returned, plus its target. */
interface JournalRecord {
  /** The entry key, repeated inside the file so a renamed file cannot masquerade. */
  readonly key: string;
  readonly baseOid: string;
  readonly snapshotFingerprint: string;
  readonly generator: string;
  readonly sliceId: string;
  /** Worker signal ranking; array order is part of the verify contract. */
  readonly statements: readonly WorkerStatement[];
  readonly droppedAnchors: number;
  readonly droppedStatements: number;
  readonly attempts: number;
  /**
   * A checksum over the worker result this record carries. Shape validation alone
   * accepts anything that is still valid JSON of the right shape — a truncated
   * statement list, a hand-edited count, a half-written file that happened to parse.
   * The checksum is what makes "these are the bytes the worker produced" a checkable
   * claim rather than an assumption.
   *
   * It covers the statement ARRAY, so an EMPTY one is covered too: a worker that
   * legitimately found nothing is reusable, and does not pay a turn on every retry
   * to rediscover that. (Emptiness through corruption fails the checksum instead.)
   */
  readonly checksum: string;
}

/** The checksum stored in, and verified against, a {@link JournalRecord}. */
function resultChecksum(
  key: string,
  statements: readonly WorkerStatement[],
  droppedAnchors: number,
  droppedStatements: number,
  attempts: number,
): string {
  return sha256Hex(canonicalize({ key, statements, droppedAnchors, droppedStatements, attempts }));
}

/**
 * The identity of "this batch at this target": the {@link JournalTarget} in full,
 * the slice id, AND the slice's exact membership by content.
 *
 * All of them, because none is sufficient alone. The base OID alone would reuse a
 * result across a re-partitioning; the slice id alone would reuse it across a
 * baseline advance; a fallback slice's id carries no content hash at all
 * (`dir:docs` says nothing about which files are in it today), so membership is
 * hashed here rather than trusted from the id; and neither says anything about the
 * prompt or the extractors that produced the answer, which is what the rest of the
 * target covers.
 */
export function journalKey(target: JournalTarget, slice: PartitionSlice): string {
  const members = slice.files.map((file) => `${file.path} ${file.blobOid}`).join("\n");
  return sha256Hex(
    `${target.baseOid}\n${target.snapshotFingerprint}\n${target.generator}\n${slice.id}\n${members}`,
  ).slice(0, 32);
}

/**
 * The subdirectory name for a target — a hash of ALL THREE fields, for exactly the
 * reason {@link journalKey} takes all three: `baseOid` alone does not identify what
 * a result was produced for. Two runs at one OID differing only by
 * `snapshotFingerprint` or `generator` would share a directory, and the first to
 * promote would `clear` the other's completed turns away.
 *
 * Hashed rather than nested three deep so the sweep in {@link KnowledgeJournal.clear}
 * stays a single `readdir`; the record inside each file still carries the target in
 * plain text, so a directory is identifiable by reading one entry.
 */
export function journalTargetDir(target: JournalTarget): string {
  return sha256Hex(`${target.baseOid}\n${target.snapshotFingerprint}\n${target.generator}`).slice(
    0,
    32,
  );
}

export class KnowledgeJournal {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** This target's own directory. Nothing outside it is ever this run's to delete. */
  private dirFor(target: JournalTarget): string {
    return join(this.dir, journalTargetDir(target));
  }

  private pathFor(target: JournalTarget, key: string): string {
    return join(this.dirFor(target), `${key}.json`);
  }

  private scopePlanPathFor(target: JournalTarget): string {
    return join(this.dirFor(target), KNOWLEDGE_SCOPE_PLAN_FILE);
  }

  /**
   * Read the selector plan only when its bytes, full target, selector identity,
   * resolved seat and current exact candidate catalogue all still agree.
   */
  readScopePlan(
    target: JournalTarget,
    input: ScopePlanJournalInput,
  ): ScopePlanJournalResult | null {
    const parsedTarget = journalTargetSchema.safeParse(target);
    const parsedInput = scopePlanInputSchema.safeParse(input);
    if (!parsedTarget.success || !parsedInput.success) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.scopePlanPathFor(target), "utf8"));
    } catch {
      return null;
    }
    const parsedRecord = scopePlanRecordSchema.safeParse(raw);
    if (!parsedRecord.success) return null;
    const record = parsedRecord.data;
    const body: ScopePlanRecordBody = {
      schemaVersion: record.schemaVersion,
      target: record.target,
      selectorGenerator: record.selectorGenerator,
      catalogueDigest: record.catalogueDigest,
      sliceCap: record.sliceCap,
      assignment: record.assignment,
      includedSliceIds: record.includedSliceIds,
      excludedSlices: record.excludedSlices,
      provenance: record.provenance,
    };
    if (record.checksum !== scopePlanChecksum(body)) return null;
    if (!sameScopePlanIdentity(body, parsedTarget.data, parsedInput.data)) return null;

    return checkedScopePlan(parsedInput.data, {
      includedSliceIds: record.includedSliceIds,
      excludedSlices: record.excludedSlices,
      provenance: record.provenance,
    });
  }

  /**
   * Atomically journal one validated whole-slice selector plan. An invalid plan or
   * failed journal write is simply not reusable; neither can fail the live run.
   */
  writeScopePlan(
    target: JournalTarget,
    input: ScopePlanJournalInput,
    result: ScopePlanJournalResult,
  ): void {
    const parsedTarget = journalTargetSchema.safeParse(target);
    const checked = checkedScopePlan(input, result);
    if (!parsedTarget.success || checked === null) return;

    const body: ScopePlanRecordBody = {
      schemaVersion: SCOPE_PLAN_SCHEMA_VERSION,
      target: parsedTarget.data,
      selectorGenerator: input.selectorGenerator,
      catalogueDigest: input.catalogueDigest,
      sliceCap: input.sliceCap,
      assignment: input.assignment,
      includedSliceIds: checked.includedSliceIds,
      excludedSlices: checked.excludedSlices,
      provenance: checked.provenance,
    };
    const record: ScopePlanRecord = { ...body, checksum: scopePlanChecksum(body) };
    try {
      mkdirSync(this.dirFor(target), { recursive: true });
      writeAtomic(this.scopePlanPathFor(target), `${canonicalize(record)}\n`);
    } catch {
      // Same fail-safe posture as worker entries: a disk failure costs one selector
      // turn on retry, never the current run or the prior live knowledge set.
    }
  }

  /**
   * The journaled result for this batch at this target, or null when there is none
   * — or when what is there does not survive being checked.
   *
   * Every refusal below costs exactly one re-run turn, which is the cheap side of
   * this trade: the expensive side is a damaged statement entering a set that then
   * fails validation whole, or a claim anchored to bytes it was never read against.
   */
  read(target: JournalTarget, slice: PartitionSlice): PartitionWorkerResult | null {
    const key = journalKey(target, slice);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.pathFor(target, key), "utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<JournalRecord>;
    // The target is re-checked against the CONTENT, not just the filename: a file
    // moved or copied between projects must not be read as this batch's result.
    if (
      record.key !== key ||
      record.baseOid !== target.baseOid ||
      record.snapshotFingerprint !== target.snapshotFingerprint ||
      record.generator !== target.generator ||
      record.sliceId !== slice.id
    ) {
      return null;
    }
    if (!Array.isArray(record.statements)) return null;
    const { droppedAnchors, droppedStatements, attempts } = record;
    if (
      typeof droppedAnchors !== "number" ||
      typeof droppedStatements !== "number" ||
      typeof attempts !== "number"
    ) {
      return null;
    }
    // Integrity before interpretation: a record whose bytes were damaged is not a
    // record, whatever shape the damage left behind.
    if (
      record.checksum !==
      resultChecksum(key, record.statements, droppedAnchors, droppedStatements, attempts)
    ) {
      return null;
    }

    // Anchors must resolve against THIS slice's membership at THIS target — path and
    // blobOid both. The key already covers membership, so this is the second lock on
    // the same door; it is here because the failure it prevents (a statement citing
    // bytes that are not in the slice it claims to be about) is invisible downstream.
    const members = new Map(slice.files.map((file) => [file.path, file.blobOid] as const));
    const statements: WorkerStatement[] = [];
    for (const entry of record.statements) {
      if (!entry || typeof entry !== "object") return null;
      const { statement, hint } = entry as { statement?: unknown; hint?: unknown };
      // Validated, not trusted: a damaged statement that reached the live store
      // would make the WHOLE set fail validation on the next read.
      const valid = validateKnowledgeStatement(statement);
      if (valid === undefined) return null;
      // The id is a hash of subject+aspect+claim+evidence, so recomputing it catches
      // any edit to the claim that left the id — and every downstream dedupe,
      // disposition carry and verdict lookup keys on that id.
      if (knowledgeStatementId(valid) !== valid.id) return null;
      if (
        valid.learnedAgainst.baseOid !== target.baseOid ||
        valid.learnedAgainst.snapshotFingerprint !== target.snapshotFingerprint ||
        valid.provenance.generator !== target.generator
      ) {
        return null;
      }
      for (const anchor of valid.evidence) {
        if (members.get(anchor.path) !== anchor.blobOid) return null;
      }
      let parsedHint: WorkerCrossSliceHint | undefined;
      if (hint !== undefined) {
        if (typeof hint !== "object" || hint === null || Array.isArray(hint)) return null;
        const candidate = hint as Record<string, unknown>;
        if (
          Object.keys(candidate).sort().join(",") !== "coupling,path" ||
          typeof candidate.path !== "string" ||
          typeof candidate.coupling !== "string" ||
          candidate.path !== candidate.path.trim() ||
          candidate.coupling !== candidate.coupling.trim() ||
          candidate.path.length === 0 ||
          candidate.coupling.length === 0 ||
          members.has(candidate.path)
        ) {
          return null;
        }
        parsedHint = { path: candidate.path, coupling: candidate.coupling };
      }
      statements.push({
        statement: valid,
        ...(parsedHint === undefined ? {} : { hint: parsedHint }),
      });
    }
    return {
      sliceId: slice.id,
      status: "ok",
      statements,
      droppedAnchors,
      droppedStatements,
      attempts,
    };
  }

  /** Journal one COMPLETED batch. A failed batch is never journaled — there is nothing to reuse. */
  write(target: JournalTarget, slice: PartitionSlice, result: PartitionWorkerResult): void {
    if (result.status !== "ok") return;
    const key = journalKey(target, slice);
    const record: JournalRecord = {
      key,
      baseOid: target.baseOid,
      snapshotFingerprint: target.snapshotFingerprint,
      generator: target.generator,
      sliceId: slice.id,
      statements: result.statements,
      droppedAnchors: result.droppedAnchors,
      droppedStatements: result.droppedStatements,
      attempts: result.attempts,
      checksum: resultChecksum(
        key,
        result.statements,
        result.droppedAnchors,
        result.droppedStatements,
        result.attempts,
      ),
    };
    try {
      mkdirSync(this.dirFor(target), { recursive: true });
      writeAtomic(this.pathFor(target, key), `${canonicalize(record)}\n`);
    } catch {
      // A journal write failing costs a re-run turn, never the run. It must not
      // fail a batch whose model work already succeeded.
    }
  }

  /** How many entries this TARGET's journal holds (for honest reporting; 0 when absent). */
  size(target: JournalTarget): number {
    try {
      return readdirSync(this.dirFor(target)).filter(
        (name) => name.endsWith(".json") && name !== KNOWLEDGE_SCOPE_PLAN_FILE,
      ).length;
    } catch {
      return 0;
    }
  }

  /**
   * Drop THIS target's journal — called only after its set has been promoted to the
   * store — and sweep any target directory that has sat untouched past
   * {@link STALE_TARGET_AGE_MS}.
   *
   * Only its own, deliberately. A recursive delete of the whole journal here is how
   * a run promoting at one baseline used to destroy a concurrent run's completed
   * turns at another.
   */
  clear(target: JournalTarget): void {
    try {
      rmSync(this.dirFor(target), { recursive: true, force: true });
    } catch {
      // Leftover journal entries are keyed by target, so a stale one is simply
      // never read again. Failing the run over an undeleted temp file would be
      // the tail wagging the dog.
    }
    const cutoff = this.now() - STALE_TARGET_AGE_MS;
    const own = journalTargetDir(target);
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === own) continue;
        const path = join(this.dir, entry.name);
        if (statSync(path).mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Same reasoning: an unswept directory costs disk, never correctness.
    }
  }
}
