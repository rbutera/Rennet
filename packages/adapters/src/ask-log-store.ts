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
import { foldAsks } from "@rennet/core";
import {
  type AskEvent,
  type AskEventBody,
  AskEventSchema,
  type AskProjection,
} from "@rennet/protocol";
import { z } from "zod";

/**
 * The durable ask-log store (B11 cluster 1, Q15) — durability for the reviewer's
 * staged asks, line comments, quote threads, retired ledger and verdict override,
 * so a review survives the process that created it. ONE append-only event log per
 * session at `~/.rennet/asks/<sessionId>.json`, sibling to the session/thread
 * stores, written atomically (temp + rename + fsync) so a reader never sees a
 * half-written file — the `session-store`/`file-thread-store` precedent.
 *
 * THE LOG IS THE ONLY WRITE PATH. `append` adds exactly one event; the projection
 * is `foldAsks(read())`, computed on demand, never a second stored copy that could
 * drift. `append` stamps the caller-agnostic bookkeeping — the `sessionId` and a
 * monotonic `seq` — onto the event body, so the sole-writer handlers upstream hand
 * a body and get back the stored event (with its seq) plus can derive the receipt.
 *
 * FAIL-SAFE READ (Rule 75): a missing or malformed file reads as an EMPTY log
 * (`[]` / the empty projection), never a throw — a corrupt ask log must degrade to
 * "nothing to rehydrate", not crash the review. A malformed file is LEFT UNTOUCHED
 * so a human can recover it: `append` REFUSES rather than clobbering unread events.
 */

/** The current ask-log-store schema version. Bumped on a breaking shape change. */
export const ASK_LOG_STORE_VERSION = 1;

const askLogFileSchema = z.object({
  version: z.number().int(),
  events: z.array(AskEventSchema),
});
type AskLogFile = z.infer<typeof askLogFileSchema>;

/** The default ask-log-store directory: `~/.rennet/asks`. Tests pass a temp dir. */
export function defaultAskLogStoreDir(): string {
  return join(homedir(), ".rennet", "asks");
}

export class AskLogStore {
  private tmpSeq = 0;

  constructor(private readonly dir: string = defaultAskLogStoreDir()) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    // The sessionId is opaque; encode it so a slash or odd char cannot escape the dir.
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  /** The distinct on-disk state for a session's log (absent / ok / malformed). A
   *  malformed file is never overwritten wholesale (Rule 75). */
  private readState(sessionId: string): {
    status: "absent" | "ok" | "malformed";
    file: AskLogFile;
  } {
    const empty: AskLogFile = { version: ASK_LOG_STORE_VERSION, events: [] };
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(sessionId), "utf8");
    } catch {
      return { status: "absent", file: empty };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "malformed", file: empty };
    }
    const result = askLogFileSchema.safeParse(parsed);
    return result.success
      ? { status: "ok", file: result.data }
      : { status: "malformed", file: empty };
  }

  /** The full event log for a session, in append order. Missing/malformed ⇒ `[]`. */
  read(sessionId: string): AskEvent[] {
    return this.readState(sessionId).file.events;
  }

  /** The current projection for a session — `foldAsks` over the log. */
  readProjection(sessionId: string): AskProjection {
    return foldAsks(this.read(sessionId));
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
  }

  /**
   * Append ONE event to a session's log and return it, stamped with the session id
   * and the next monotonic `seq` (`last.seq + 1`, starting at 0). Additive: every
   * prior event is preserved, the new one lands last. Refuses on a malformed file
   * rather than clobbering unread history.
   */
  append(sessionId: string, body: AskEventBody): AskEvent {
    const state = this.readState(sessionId);
    if (state.status === "malformed") {
      throw new Error(`refusing to append to a malformed ask log for session ${sessionId}`);
    }
    const events = state.file.events;
    const seq = (events.at(-1)?.seq ?? -1) + 1;
    const event = { ...body, sessionId, seq } as AskEvent;
    this.write(sessionId, [...events, event]);
    return event;
  }
}
