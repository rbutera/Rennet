import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { LENS_KINDS, ViolationSchema } from "@rennet/protocol";
import { z } from "zod";

/**
 * The board-meta store (#464 finding 3, B09 cluster 6, reconciliation 5) — the
 * durable home for a board's coverage/validation metadata that the whiteboard
 * event log CANNOT carry: `skippedHunks` (coverage) and the validation
 * blemishes/omissions/immutability. `draftToOps` serializes only a board's
 * ELEMENTS; the 13-kind element vocabulary has no element for board-level
 * coverage, so a result reconstructed after a crash would otherwise lose it.
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

const SkippedHunkSchema = z.object({ hunk: z.string().min(1), reason: z.string() });
const OmissionSchema = z.object({
  elementId: z.string().min(1),
  hunks: z.array(z.string()),
  reason: z.string(),
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
  skippedHunks: z.array(SkippedHunkSchema),
  blemishes: z.array(ViolationSchema),
  omissions: z.array(OmissionSchema),
  immutability: z.array(ViolationSchema),
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
  readonly skippedHunks: readonly { readonly hunk: string; readonly reason: string }[];
  readonly blemishes: readonly z.infer<typeof ViolationSchema>[];
  readonly omissions: readonly {
    readonly elementId: string;
    readonly hunks: readonly string[];
    readonly reason: string;
  }[];
  readonly immutability: readonly z.infer<typeof ViolationSchema>[];
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
