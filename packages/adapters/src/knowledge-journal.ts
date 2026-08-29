import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PartitionSlice, PartitionWorkerResult, WorkerStatement } from "@rennet/core";
import { validateKnowledgeStatement } from "@rennet/core";
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
 * FAIL-SAFE throughout (Rule 75): an unreadable, malformed, or foreign-target entry
 * reads as "not journaled", which costs one re-run turn. It never throws, and it
 * never lets a damaged statement into a set.
 */

/** The journal directory name, sibling to `knowledge/` inside the project's store dir. */
export const KNOWLEDGE_JOURNAL_DIR = "knowledge-journal";

/** One journaled batch: exactly what `runPartitionWorker` returned, plus its target. */
interface JournalRecord {
  /** The entry key, repeated inside the file so a renamed file cannot masquerade. */
  readonly key: string;
  readonly baseOid: string;
  readonly sliceId: string;
  readonly statements: readonly WorkerStatement[];
  readonly droppedAnchors: number;
  readonly droppedStatements: number;
  readonly attempts: number;
}

/**
 * The identity of "this batch at this target": the base OID, the slice id, AND the
 * slice's exact membership by content.
 *
 * All three, because none of them is sufficient alone. The base OID alone would
 * reuse a result across a re-partitioning; the slice id alone would reuse it across
 * a baseline advance; and a fallback slice's id carries no content hash at all
 * (`dir:docs` says nothing about which files are in it today), so membership has to
 * be hashed here rather than trusted from the id.
 */
export function journalKey(baseOid: string, slice: PartitionSlice): string {
  const members = slice.files.map((file) => `${file.path} ${file.blobOid}`).join("\n");
  return sha256Hex(`${baseOid}\n${slice.id}\n${members}`).slice(0, 32);
}

export class KnowledgeJournal {
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /** The journaled result for this batch at this target, or null when there is none. */
  read(baseOid: string, slice: PartitionSlice): PartitionWorkerResult | null {
    const key = journalKey(baseOid, slice);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.pathFor(key), "utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<JournalRecord>;
    // The key is re-checked against the CONTENT, not just the filename: a file
    // moved or copied between projects must not be read as this batch's result.
    if (record.key !== key || record.baseOid !== baseOid || record.sliceId !== slice.id)
      return null;
    if (!Array.isArray(record.statements)) return null;

    const statements: WorkerStatement[] = [];
    for (const entry of record.statements) {
      if (!entry || typeof entry !== "object") return null;
      const { statement, hint } = entry as { statement?: unknown; hint?: unknown };
      // Validated, not trusted: a damaged statement that reached the live store
      // would make the WHOLE set fail validation on the next read.
      const valid = validateKnowledgeStatement(statement);
      if (valid === undefined) return null;
      statements.push({ statement: valid, ...(typeof hint === "string" ? { hint } : {}) });
    }
    return {
      sliceId: slice.id,
      status: "ok",
      statements,
      droppedAnchors: typeof record.droppedAnchors === "number" ? record.droppedAnchors : 0,
      droppedStatements:
        typeof record.droppedStatements === "number" ? record.droppedStatements : 0,
      attempts: typeof record.attempts === "number" ? record.attempts : 0,
    };
  }

  /** Journal one COMPLETED batch. A failed batch is never journaled — there is nothing to reuse. */
  write(baseOid: string, slice: PartitionSlice, result: PartitionWorkerResult): void {
    if (result.status !== "ok") return;
    const record: JournalRecord = {
      key: journalKey(baseOid, slice),
      baseOid,
      sliceId: slice.id,
      statements: result.statements,
      droppedAnchors: result.droppedAnchors,
      droppedStatements: result.droppedStatements,
      attempts: result.attempts,
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.pathFor(record.key), `${canonicalize(record)}\n`);
    } catch {
      // A journal write failing costs a re-run turn, never the run. It must not
      // fail a batch whose model work already succeeded.
    }
  }

  /** How many entries the journal holds (for honest reporting; 0 when absent). */
  size(): number {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /** Drop the whole journal — called ONLY after the set has been promoted to the store. */
  clear(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Leftover journal entries are keyed by target, so a stale one is simply
      // never read again. Failing the run over an undeleted temp file would be
      // the tail wagging the dog.
    }
  }
}
