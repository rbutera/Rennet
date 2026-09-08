import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Generation,
  GenerationSchema,
  ROUND_NO_REGEN,
  type RoundRecord,
  RoundRecordSchema,
} from "@rennet/protocol";
import { z } from "zod";

/**
 * Durable homes for what a round MINTS (C15 cluster 2) — the generation ledger
 * that must survive the process that drafted it, so the frozen prior generation
 * is reachable as a drill-down after a restart and the reviewer's rounds ledger
 * is not lost with the runtime. Sibling to the `board-meta`/`ask` stores under
 * `~/.rennet`, written atomically (temp + fsync + rename + parent-dir fsync) so a
 * reader never sees a half-written file — the `ask-log-store` precedent.
 *
 * ABSENT vs CORRUPT (the ask-log discipline, NOT board-meta's fail-safe read).
 * A minted generation is real evidence; losing it silently would let the ledger
 * open a live generation while claiming an earlier one is gone, or drop a round.
 * So ONLY a missing file (ENOENT) is the honest absent state; a file that EXISTS
 * but cannot be trusted — an IO/permission error, malformed JSON, or a schema
 * mismatch — THROWS ({@link RoundStoreCorruptError}) rather than folding away to
 * "no such generation". The corrupt file is left untouched for a human to recover.
 */

/** A persisted round artefact exists but cannot be trusted (corrupt/unreadable). Thrown
 *  by the stores' reads so a caller surfaces the fault rather than fabricating an absent
 *  generation/record. NOT thrown for an absent (ENOENT) file — that is the honest empty. */
export class RoundStoreCorruptError extends Error {
  constructor(id: string, detail: string) {
    super(`round artefact ${id} is unreadable/corrupt: ${detail}`);
    this.name = "RoundStoreCorruptError";
  }
}

/** Atomic JSON write: temp file, fsync its contents, rename over the target, fsync the
 *  parent dir. The rename is atomic for readers; the two fsyncs make it durable across a
 *  crash (unflushed contents / an unflushed dir entry are the two loss windows). */
function atomicWriteJson(dir: string, path: string, tmpSeq: number, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${tmpSeq}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Read + JSON-parse a file. ENOENT ⇒ `undefined` (honest absent); any other read error
 *  or malformed JSON ⇒ THROW {@link RoundStoreCorruptError}. */
function readJsonStrict(path: string, id: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new RoundStoreCorruptError(id, `read failed (${String(err)})`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RoundStoreCorruptError(id, "malformed JSON");
  }
}

/** The default generation-store directory: `~/.rennet/generations`. Tests pass a temp dir. */
export function defaultGenerationStoreDir(): string {
  return join(homedir(), ".rennet", "generations");
}

/**
 * Revisioned generation documents. SQLite owns the conditional freeze across processes;
 * legacy JSON is imported lazily and retained as recovery evidence.
 */
export class GenerationStore {
  private readonly database: DatabaseSync;

  constructor(private readonly dir: string = defaultGenerationStoreDir()) {
    mkdirSync(dir, { recursive: true });
    this.database = new DatabaseSync(join(dir, "generations.sqlite"));
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        document TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  private pathFor(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  /** Persist one generation atomically, keyed by its id. Overwrites (a live generation
   *  re-saved as frozen replaces the live copy under the same id). */
  save(gen: Generation): void {
    const validated = GenerationSchema.parse(gen);
    this.database
      .prepare(`
      INSERT INTO generations (id, revision, document) VALUES (?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET revision = revision + 1, document = excluded.document
    `)
      .run(validated.id, JSON.stringify(validated));
  }

  saveIfRevision(gen: Generation, expectedRevision: number): boolean {
    const validated = GenerationSchema.parse(gen);
    return (
      this.database
        .prepare(`
      UPDATE generations SET document = ?, revision = revision + 1
      WHERE id = ? AND revision = ?
    `)
        .run(JSON.stringify(validated), validated.id, expectedRevision).changes === 1
    );
  }

  /** Load one generation by id. Absent (never persisted) ⇒ `undefined`; corrupt ⇒ THROW. */
  load(id: string): Generation | undefined {
    return this.loadVersion(id)?.generation;
  }

  loadVersion(id: string): { generation: Generation; revision: number } | undefined {
    const row = this.database
      .prepare("SELECT revision, document FROM generations WHERE id = ?")
      .get(id);
    if (row !== undefined) {
      if (typeof row.document !== "string" || typeof row.revision !== "number") {
        throw new RoundStoreCorruptError(id, "invalid database row");
      }
      const result = GenerationSchema.safeParse(JSON.parse(row.document));
      if (!result.success) throw new RoundStoreCorruptError(id, "schema mismatch");
      return { generation: result.data, revision: row.revision };
    }
    const parsed = readJsonStrict(this.pathFor(id), id);
    if (parsed === undefined) return undefined;
    const result = GenerationSchema.safeParse(parsed);
    if (!result.success) throw new RoundStoreCorruptError(id, "schema mismatch");
    this.database
      .prepare("INSERT OR IGNORE INTO generations (id, revision, document) VALUES (?, 1, ?)")
      .run(id, JSON.stringify(result.data));
    return this.loadVersion(id);
  }

  /** Compare and replace are one database statement; every save advances the revision. */
  freeze(id: string, expectedRevision: number): Generation | undefined {
    const row = this.database
      .prepare(`
      UPDATE generations
      SET document = json_set(document, '$.status', 'frozen'), revision = revision + 1
      WHERE id = ? AND revision = ?
      RETURNING document
    `)
      .get(id, expectedRevision);
    return row === undefined ? undefined : GenerationSchema.parse(JSON.parse(String(row.document)));
  }
}

/** The current round-record-store schema version. Bumped on a breaking shape change. */
export const ROUND_RECORD_STORE_VERSION = 1;

const roundLedgerFileSchema = z.object({
  version: z.number().int(),
  records: z.array(RoundRecordSchema),
});

/** The default round-record-store directory: `~/.rennet/rounds`. Tests pass a temp dir. */
export function defaultRoundRecordStoreDir(): string {
  return join(homedir(), ".rennet", "rounds");
}

/**
 * The durable rounds ledger (C15 2.2) — one JSON document per session at
 * `<dir>/<sessionId>.json` holding that session's `RoundRecord[]` in round order.
 * Reconciles the TWO records a regeneration round produces into ONE: the dispatch
 * path writes a `ROUND_NO_REGEN` placeholder (carrying the checkpoint diff/outcome),
 * then `runRound` writes the real-generation record for the SAME dispatch identity.
 * {@link record} recognises the second as the first's completion and
 * REPLACES the placeholder in place — the durable ledger carries one record per round,
 * the real minted generation plus the frozen-predecessor id, over the placeholder's diff.
 *
 * A dispatch-only round (no regeneration follows) keeps its `ROUND_NO_REGEN` marker —
 * the honest "ran a work-order, regenerated nothing" record. Absent session ⇒ empty
 * ledger; a corrupt file THROWS rather than dropping the reviewer's round history.
 */
export class RoundRecordStore {
  private tmpSeq = 0;

  constructor(private readonly dir: string = defaultRoundRecordStoreDir()) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  /** A session's rounds ledger in order. Absent ⇒ `[]`; corrupt ⇒ THROW. */
  read(sessionId: string): RoundRecord[] {
    const parsed = readJsonStrict(this.pathFor(sessionId), sessionId);
    if (parsed === undefined) return [];
    const result = roundLedgerFileSchema.safeParse(parsed);
    if (!result.success) throw new RoundStoreCorruptError(sessionId, "schema mismatch");
    if (result.data.version !== ROUND_RECORD_STORE_VERSION) {
      throw new RoundStoreCorruptError(
        sessionId,
        `unknown store version ${result.data.version} (expected ${ROUND_RECORD_STORE_VERSION})`,
      );
    }
    return result.data.records;
  }

  /**
   * Record one round, reconciling to ONE record per round. A real-generation record
   * (`boardGeneration !== ROUND_NO_REGEN`) SUPERSEDES the same round's dispatch
   * placeholder. New records match by `dispatchId`; records written by an older daemon
   * fall back to a matching worker commit range only when neither side has an identity.
   * keeping the placeholder's checkpoint diff/outcome/changedPaths that the regeneration
   * path does not carry. Anything else appends. Refuses over a corrupt file.
   */
  record(sessionId: string, incoming: RoundRecord): void {
    const records = this.read(sessionId);
    if (
      incoming.dispatchId !== undefined &&
      records.some(
        (record) =>
          record.dispatchId === incoming.dispatchId && record.boardGeneration !== ROUND_NO_REGEN,
      )
    )
      return;
    if (
      incoming.boardGeneration === ROUND_NO_REGEN &&
      incoming.outcome === "completed" &&
      incoming.dispatchId !== undefined &&
      incoming.regeneration !== undefined
    ) {
      const idx = lastSameDispatchPlaceholderIndex(records, incoming.dispatchId);
      if (idx >= 0) {
        const existing = records[idx] as RoundRecord;
        records[idx] = {
          ...existing,
          ...incoming,
          ...(existing.run === undefined ? {} : { run: existing.run }),
        };
        this.write(sessionId, records);
        return;
      }
    }
    if (incoming.boardGeneration !== ROUND_NO_REGEN) {
      const idx = lastPlaceholderIndex(records, incoming);
      if (idx >= 0) {
        const placeholder = records[idx] as RoundRecord;
        const reconciled = {
          ...placeholder,
          ...incoming,
          // Preserve the dispatch placeholder's checkpoint truth (the regeneration path
          // has no diff of its own) — one record with the real generation AND the diff.
          ...(placeholder.outcome === undefined ? {} : { outcome: placeholder.outcome }),
          ...(placeholder.diff === undefined ? {} : { diff: placeholder.diff }),
          ...(placeholder.changedPaths === undefined
            ? {}
            : { changedPaths: placeholder.changedPaths }),
          ...(placeholder.run === undefined ? {} : { run: placeholder.run }),
        } satisfies RoundRecord;
        delete reconciled.regeneration;
        records[idx] = reconciled;
        this.write(sessionId, records);
        return;
      }
    }
    this.write(sessionId, [...records, incoming]);
  }

  private write(sessionId: string, records: RoundRecord[]): void {
    atomicWriteJson(this.dir, this.pathFor(sessionId), this.tmpSeq++, {
      version: ROUND_RECORD_STORE_VERSION,
      records,
    });
  }
}

function lastSameDispatchPlaceholderIndex(
  records: readonly RoundRecord[],
  dispatchId: string,
): number {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as RoundRecord;
    if (
      record.boardGeneration === ROUND_NO_REGEN &&
      record.outcome === "completed" &&
      record.dispatchId === dispatchId
    ) {
      return i;
    }
  }
  return -1;
}

/** The index of the completed dispatch placeholder a real-generation record completes.
 * New records use the stable dispatch identity. The commit-range fallback is restricted
 * to two legacy records so an old placeholder can still finish without cross-matching a
 * different modern dispatch that happened to observe the same HEAD range. */
function lastPlaceholderIndex(records: readonly RoundRecord[], incoming: RoundRecord): number {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as RoundRecord;
    const sameDispatch =
      incoming.dispatchId !== undefined
        ? r.dispatchId === incoming.dispatchId
        : r.dispatchId === undefined &&
          r.workerCommitRange.from === incoming.workerCommitRange.from &&
          r.workerCommitRange.to === incoming.workerCommitRange.to;
    if (r.boardGeneration === ROUND_NO_REGEN && r.outcome === "completed" && sameDispatch) {
      return i;
    }
  }
  return -1;
}
