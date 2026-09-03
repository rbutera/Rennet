import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type BoardDocument,
  BoardDocumentSchema,
  LENS_KINDS,
  ViolationSchema,
} from "@rennet/protocol";
import { z } from "zod";

/**
 * The board-meta store (#464 finding 3, B09 cluster 6, reconciliation 5) — the
 * durable home for board-level data that the whiteboard event log CANNOT carry:
 * the document opening and validation
 * blemishes/omissions/immutability. `draftToOps` serializes only a board's
 * ELEMENTS; the 13-kind element vocabulary has no element for any of these, so
 * a result reconstructed after a crash would otherwise lose them.
 * The lens pipeline persists each board's meta HERE (its `persistBoardMeta`
 * seam) after the write is accepted and BEFORE arrival is announced, so a
 * reader reconstructing the result never sees an announced board whose coverage
 * was lost.
 *
 * One JSON document per board at `<dir>/<boardId>.json`, keyed by board id,
 * written atomically (temp + rename) so a reader never sees a half-written file
 * — the `session-store`/`file-thread-store` precedent. `BoardMeta` is B08's
 * shape (`server/runtime/lens-pipeline.ts`); adapters sits BELOW server, so the
 * store declares the persistence schema structurally over the protocol/core
 * types the shape is made of (consumed, not re-modeled — reconciliation 5). The
 * `save` input uses readonly arrays so B08's `BoardMeta` (readonly throughout)
 * is assignable to it at the composition root.
 *
 * FAIL-SAFE READ (Rule 75): a missing or malformed file resolves to `undefined`
 * (load) or is skipped (list), never a throw — losing one board's coverage must
 * degrade to "coverage unknown for that board", not crash a reconstruction. A
 * malformed file is LEFT UNTOUCHED so a human can recover it.
 */

/** The lint targets a board can carry meta for: the five lenses plus the round report. */
const LINT_TARGETS = [...LENS_KINDS, "report"] as const;

// Records written before session-bound-workspace D5 carry `skippedHunks` and an
// `omissions[].hunks` list; both are stripped on read, since nothing consumes a hunk id.
const OmissionSchema = z.object({
  elementId: z.string().min(1),
  reason: z.string(),
});
/** One provable reference repair the write boundary made before this board was written
 *  (#548 D1). Durable so a repair stays accountable after the run that made it. */
const RefRepairSchema = z.object({
  elementId: z.string().min(1),
  field: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

/** The persisted board-meta shape — structurally B08's `BoardMeta`, validated on read.
 *  `session`/`generation` are the durable idempotency linkage (B09 F1): they tag each
 *  board's meta with the (session, patchset generation) that drafted it, so a fresh
 *  runtime after a restart can ask "did this (session, generation) already draft?"
 *  from durable evidence — the crash-boundary truth the in-memory guard cannot carry.
 *  Optional so a non-rounds writer (or a pre-F1 record) still validates. */
export const BoardMetaRecordSchema = z.object({
  lens: z.enum(LINT_TARGETS),
  boardId: z.string().min(1),
  // Optional on read so board metadata written before the document contract remains valid.
  document: BoardDocumentSchema.optional(),
  blemishes: z.array(ViolationSchema),
  omissions: z.array(OmissionSchema),
  immutability: z.array(ViolationSchema),
  // Optional on read: boards written before reference admission carry no repairs, and an
  // empty repair list is not written at all.
  refRepairs: z.array(RefRepairSchema).optional(),
  session: z.string().min(1).optional(),
  generation: z.string().min(1).optional(),
});
export type BoardMetaRecord = z.infer<typeof BoardMetaRecordSchema>;

/**
 * The `save` input: B08's `BoardMeta` shape with readonly arrays, so a value
 * typed as the pipeline's `BoardMeta` (readonly throughout) is assignable here
 * without importing across the adapters→server boundary.
 */
export interface BoardMetaInput {
  readonly lens: (typeof LINT_TARGETS)[number];
  readonly boardId: string;
  /** New pipeline writes always carry this; optional admits legacy/non-pipeline callers. */
  readonly document?: BoardDocument;
  readonly blemishes: readonly z.infer<typeof ViolationSchema>[];
  readonly omissions: readonly {
    readonly elementId: string;
    readonly reason: string;
  }[];
  readonly immutability: readonly z.infer<typeof ViolationSchema>[];
  /** Reference repairs made at the write boundary (#548 D1); absent when none were. */
  readonly refRepairs?: readonly z.infer<typeof RefRepairSchema>[];
  /** The durable idempotency linkage (B09 F1): the session + patchset generation
   *  that drafted this board. Absent for non-rounds writers. */
  readonly session?: string;
  readonly generation?: string;
}

export class BoardMetaStore {
  private tmpSeq = 0;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(boardId: string): string {
    // The boardId is opaque; encode it so a slash or odd char cannot escape the dir.
    return join(this.dir, `${encodeURIComponent(boardId)}.json`);
  }

  /** Persist one board's meta atomically (temp + rename). Overwrites the record for its board. */
  save(meta: BoardMetaInput): void {
    const validated = BoardMetaRecordSchema.parse(meta);
    const path = this.pathFor(validated.boardId);
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    // fsync the temp file's contents to disk BEFORE the rename (F7): rename is
    // atomic for readers, but without the fsync a crash can leave the renamed file
    // pointing at unflushed (empty/partial) data. Cheap real data-loss prevention.
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, `${JSON.stringify(validated, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  /** Remove one board's metadata. Missing is already the desired state. */
  remove(boardId: string): void {
    rmSync(this.pathFor(boardId), { force: true });
  }

  /** Load one board's meta, WITH schema validation. Missing/malformed ⇒ `undefined` (fail-safe). */
  load(boardId: string): BoardMetaRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(boardId), "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = BoardMetaRecordSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  }

  /**
   * The durable idempotency query (B09 F1): every board-meta record drafted by a
   * given (session, generation). A fresh runtime after a restart reads THIS to
   * learn a generation already drafted its boards — the crash-boundary evidence
   * that stops a post-restart re-entry from re-drafting. Empty ⇒ not yet drafted.
   */
  listForGeneration(session: string, generation: string): BoardMetaRecord[] {
    return this.list().filter((r) => r.session === session && r.generation === generation);
  }

  /** Every persisted board-meta record. Malformed entries are skipped, not thrown. */
  list(): BoardMetaRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: BoardMetaRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = this.load(decodeURIComponent(name.slice(0, -".json".length)));
      if (record) records.push(record);
    }
    return records;
  }
}
