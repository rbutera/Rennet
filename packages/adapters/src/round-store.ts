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
import { type Generation, GenerationSchema } from "@rennet/protocol";

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
 * The durable generation store (C15 2.1) — one JSON document per generation at
 * `<dir>/<generationId>.json`. Persists the frozen prior and the live successor a
 * round mints, so gen-1 survives a restart as a drill-down the ledger's generation
 * switcher can open by id (C15 2.3). A generation never persisted is honestly absent
 * (`undefined`), never a fabricated board set.
 */
export class GenerationStore {
  private tmpSeq = 0;

  constructor(private readonly dir: string = defaultGenerationStoreDir()) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  /** Persist one generation atomically, keyed by its id. Overwrites (a live generation
   *  re-saved as frozen replaces the live copy under the same id). */
  save(gen: Generation): void {
    const validated = GenerationSchema.parse(gen);
    atomicWriteJson(this.dir, this.pathFor(validated.id), this.tmpSeq++, validated);
  }

  /** Load one generation by id. Absent (never persisted) ⇒ `undefined`; corrupt ⇒ THROW. */
  load(id: string): Generation | undefined {
    const parsed = readJsonStrict(this.pathFor(id), id);
    if (parsed === undefined) return undefined;
    const result = GenerationSchema.safeParse(parsed);
    if (!result.success) throw new RoundStoreCorruptError(id, "schema mismatch");
    return result.data;
  }
}
