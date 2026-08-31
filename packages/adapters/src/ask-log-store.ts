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
import { applyAskEvent, foldAsks } from "@rennet/core";
import {
  type AskEvent,
  type AskEventBody,
  AskEventSchema,
  type AskProjection,
} from "@rennet/protocol";
import { z } from "zod";
import { ParsedFileCache } from "./parsed-file-cache";

/**
 * The durable ask-log store (B11 cluster 1, Q15) — durability for the reviewer's
 * staged asks, line comments, quote threads, retired ledger and verdict override,
 * so a review survives the process that created it. ONE append-only event log per
 * session at `~/.rennet/asks/<sessionId>.json`, sibling to the session/thread
 * stores, written atomically (temp + rename + fsync) so a reader never sees a
 * half-written file — the `session-store`/`file-thread-store` precedent.
 *
 * THE LOG IS THE ONLY WRITE PATH. `append` adds exactly one event and `appendMany`
 * atomically adds one related batch; the projection is `foldAsks(read())`, computed
 * on demand, never a second stored copy that could drift. Both append paths stamp
 * caller-agnostic bookkeeping — the `sessionId` and monotonic `seq` values — onto
 * event bodies, so upstream writers get back the stored events and can derive receipts.
 *
 * ABSENT vs CORRUPT (B11 P0 finding 1). A MISSING log (ENOENT) is the honest empty
 * state — a review with no asks yet folds to the empty projection, no error. But a
 * file that EXISTS and cannot be trusted — an IO/permission error, malformed JSON, a
 * schema mismatch, the wrong store version, an event stamped with another session, or
 * a non-contiguous sequence — is NOT "no asks": it is unread history we must not fold
 * away to an empty review (that would post a clean review over lost data — a silent
 * lie). So `read`/`readProjection` THROW an {@link AskLogCorruptError} on any such
 * state, and `append` REFUSES rather than clobbering the file. This is honest failure,
 * not a gate: the corrupt file is left untouched for a human to recover, and every
 * exit (compose, ask.read) surfaces the fault instead of a fabricated empty projection.
 *
 * IN-MEMORY LOG (perf audit §3 H1). The parsed events and their folded projection are
 * memoized per log path through {@link ParsedFileCache}, so the three `readProjection`
 * calls each ask write makes (`dispatch/ask.ts`) cost one `stat` apiece instead of three
 * full reads, three zod walks and three folds. Nothing about the ON-DISK shape changes:
 * the same pretty-printed document, the same temp+fsync+rename+dir-fsync. The seq
 * contiguity check still runs on every real parse — a cold read, or any read after the
 * file changed underneath us — it is simply not re-run against bytes we already validated.
 */

/** The current ask-log-store schema version. Bumped on a breaking shape change. */
export const ASK_LOG_STORE_VERSION = 1;

/**
 * A session's ask log exists but cannot be trusted (corrupt/incomplete). Thrown by
 * `read`/`readProjection` and by `append` so an exit surfaces the fault rather than
 * folding the log away to an empty review (B11 P0 finding 1). NOT thrown for an absent
 * log — that is the honest empty state.
 */
export class AskLogCorruptError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`ask log for session ${sessionId} is unreadable/corrupt: ${detail}`);
    this.name = "AskLogCorruptError";
  }
}

const askLogFileSchema = z.object({
  version: z.number().int(),
  events: z.array(AskEventSchema),
});
type AskLogFile = z.infer<typeof askLogFileSchema>;

/** The default ask-log-store directory: `~/.rennet/asks`. Tests pass a temp dir. */
export function defaultAskLogStoreDir(): string {
  return join(homedir(), ".rennet", "asks");
}

/** The memoized parse of one log file: its events and, once anyone asked, their fold. */
interface CachedLog {
  events: AskEvent[];
  projection: AskProjection | undefined;
}

export class AskLogStore {
  private tmpSeq = 0;
  private readonly cache = new ParsedFileCache<CachedLog>();

  constructor(private readonly dir: string = defaultAskLogStoreDir()) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    // The sessionId is opaque; encode it so a slash or odd char cannot escape the dir.
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  /** The distinct on-disk state for a session's log (absent / ok / corrupt). Only an
   *  ENOENT read is `absent`; every other fault (IO/permission, malformed JSON, schema
   *  mismatch, wrong version, foreign session id, non-contiguous seq) is `corrupt` —
   *  unread history we refuse to fold away. A corrupt file is never overwritten. */
  private readState(sessionId: string): {
    status: "absent" | "ok" | "corrupt";
    file: AskLogFile;
    detail?: string;
  } {
    const empty: AskLogFile = { version: ASK_LOG_STORE_VERSION, events: [] };
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(sessionId), "utf8");
    } catch (err) {
      // ONLY a missing file is the honest empty state. A permission/IO error names a
      // file that exists but could not be read — corrupt, not absent.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { status: "absent", file: empty };
      }
      return { status: "corrupt", file: empty, detail: `read failed (${String(err)})` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "corrupt", file: empty, detail: "malformed JSON" };
    }
    const result = askLogFileSchema.safeParse(parsed);
    if (!result.success) {
      return { status: "corrupt", file: empty, detail: "schema mismatch" };
    }
    const file = result.data;
    if (file.version !== ASK_LOG_STORE_VERSION) {
      return {
        status: "corrupt",
        file: empty,
        detail: `unknown store version ${file.version} (expected ${ASK_LOG_STORE_VERSION})`,
      };
    }
    // Every event must belong to THIS session and carry a contiguous seq (0..n-1) — a
    // foreign id or a gap means the log was tampered with or a write was torn.
    for (let i = 0; i < file.events.length; i++) {
      const event = file.events[i];
      if (event === undefined) continue;
      if (event.sessionId !== sessionId) {
        return { status: "corrupt", file: empty, detail: `event ${i} belongs to another session` };
      }
      if (event.seq !== i) {
        return {
          status: "corrupt",
          file: empty,
          detail: `event ${i} has non-contiguous seq ${event.seq}`,
        };
      }
    }
    return { status: "ok", file };
  }

  /** The memoized log for a session, parsed from disk only when the cache misses. A corrupt
   *  file throws with `suffix` appended to the detail (the append path refuses differently
   *  from the read path) and is never memoized. */
  private cachedLog(sessionId: string, suffix = ""): CachedLog {
    const path = this.pathFor(sessionId);
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    const state = this.readState(sessionId);
    if (state.status === "corrupt") {
      throw new AskLogCorruptError(sessionId, `${state.detail ?? "unknown"}${suffix}`);
    }
    const entry: CachedLog = { events: state.file.events, projection: undefined };
    // An ABSENT log has no file to stamp, so there is nothing to memoize against — the
    // ENOENT read is already the cheap path, and the first append creates the file.
    if (state.status === "ok") this.cache.set(path, entry);
    return entry;
  }

  /** The full event log for a session, in append order. Absent ⇒ `[]`; corrupt ⇒ THROW
   *  ({@link AskLogCorruptError}) — never fold unread history away to an empty review. */
  read(sessionId: string): AskEvent[] {
    // A copy: the array is memoized, and a caller sorting or splicing it must not edit
    // the store's state. The events themselves are immutable append-only records.
    return [...this.cachedLog(sessionId).events];
  }

  /** The current projection for a session — `foldAsks` over the log. Corrupt ⇒ THROW. */
  readProjection(sessionId: string): AskProjection {
    const cached = this.cachedLog(sessionId);
    cached.projection ??= foldAsks(cached.events);
    return cached.projection;
  }

  private write(sessionId: string, events: AskEvent[]): void {
    const path = this.pathFor(sessionId);
    const next: AskLogFile = { version: ASK_LOG_STORE_VERSION, events };
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    // fsync the temp file's contents to disk BEFORE the rename: rename is atomic
    // for readers, but without the fsync a crash can leave the renamed file pointing
    // at unflushed (empty/partial) data. Cheap real data-loss prevention.
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    // fsync the DIRECTORY too: the rename is durable for readers only once the parent
    // directory entry is flushed — without this a crash right after the rename can lose
    // the new file entirely (the renamed name never hit disk). Cheap data-loss prevention.
    const dirFd = openSync(this.dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /**
   * Append ONE event to a session's log and return it, stamped with the session id
   * and the next monotonic `seq` (`last.seq + 1`, starting at 0). Additive: every
   * prior event is preserved, the new one lands last. Refuses on a corrupt file
   * rather than clobbering unread history.
   */
  append(sessionId: string, body: AskEventBody): AskEvent {
    const [event] = this.appendMany(sessionId, [body]);
    if (event === undefined) {
      throw new Error("appendMany returned no event for a non-empty batch");
    }
    return event;
  }

  /**
   * Append a related batch with one read and one atomic write. Events receive
   * contiguous sequence numbers in caller order. This is the durable boundary for
   * host migrations that must never leave a partially-applied disposition set.
   */
  appendMany(sessionId: string, bodies: readonly AskEventBody[]): AskEvent[] {
    if (bodies.length === 0) return [];

    const cached = this.cachedLog(sessionId, " — refusing to append over unread history");
    const events = cached.events;
    const firstSeq = (events.at(-1)?.seq ?? -1) + 1;
    const appended = bodies.map(
      (body, index) => ({ ...body, sessionId, seq: firstSeq + index }) as AskEvent,
    );
    const next = [...events, ...appended];
    this.write(sessionId, next);
    // WRITE THROUGH. The file we just landed IS this state, so memoize it rather than
    // making the next read re-parse what we already hold. The projection extends
    // incrementally: `applyAskEvent` is the very step `foldAsks` reduces with, so folding
    // only the appended events onto the prior projection equals a fold over the whole log —
    // without which each append would still re-walk every event.
    this.cache.set(this.pathFor(sessionId), {
      events: next,
      projection:
        cached.projection === undefined
          ? undefined
          : appended.reduce(applyAskEvent, cached.projection),
    });
    return appended;
  }
}
