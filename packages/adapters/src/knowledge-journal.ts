import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PartitionSlice, PartitionWorkerResult, WorkerStatement } from "@rennet/core";
import { knowledgeStatementId, validateKnowledgeStatement } from "@rennet/core";
import { canonicalize, sha256Hex } from "@rennet/protocol";
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

/** One journaled batch: exactly what `runPartitionWorker` returned, plus its target. */
interface JournalRecord {
  /** The entry key, repeated inside the file so a renamed file cannot masquerade. */
  readonly key: string;
  readonly baseOid: string;
  readonly snapshotFingerprint: string;
  readonly generator: string;
  readonly sliceId: string;
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
        valid.learnedAgainst.snapshotFingerprint !== target.snapshotFingerprint
      ) {
        return null;
      }
      for (const anchor of valid.evidence) {
        if (members.get(anchor.path) !== anchor.blobOid) return null;
      }
      statements.push({ statement: valid, ...(typeof hint === "string" ? { hint } : {}) });
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
      return readdirSync(this.dirFor(target)).filter((name) => name.endsWith(".json")).length;
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
