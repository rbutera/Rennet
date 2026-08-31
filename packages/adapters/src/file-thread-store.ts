import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ConversationAnchorWire,
  PersistedThreadMessageWire,
  PersistedThreadWire,
} from "@rennet/protocol";
import { persistedThreadSchema } from "@rennet/protocol";
import { z } from "zod";
import { ParsedFileCache } from "./parsed-file-cache";

/**
 * The conversation THREAD store (issue #251) — durability for the inline research
 * conversation, so a thread survives the process that created it. One JSON document
 * per review at `~/.rennet/threads/<reviewId>.json`, sibling to the config and
 * snapshot stores, written atomically (temp + rename) so a reader never sees a
 * half-written file.
 *
 * ⭐ THE CRASH-RECOVERY TRANSFORM is the load-bearing guard (criterion 3). A turn that
 * was `streaming` when the process died is read back as `interrupted`, NEVER as a
 * fabricated `complete` and never left as a stuck `streaming`. The transform runs at
 * READ time, so a process that died cannot leave a record that reads as live: the only
 * way a message reads `complete` is if a real completion wrote it that way.
 *
 * "Only completed messages persist" (spec): a `streaming` placeholder carries NO body
 * (the coalesced deltas are never written); on completion it is REPLACED by the durable
 * message. So an interrupted turn recovers with an empty body and an honest flag — never
 * a partial answer masquerading as finished.
 *
 * FAIL-SAFE READ (Rule 75): a missing, unreadable, or malformed file resolves to NO
 * threads (`[]`), never a throw — a corrupt thread file must degrade to "nothing to
 * reattach", not crash the review. A file that could not be parsed is LEFT UNTOUCHED so
 * a human can recover it; a subsequent write lays down a clean shape only for the
 * thread it touches.
 *
 * IN-MEMORY THREADS (perf audit §4 H4). The parsed file is memoized per review path
 * through {@link ParsedFileCache}, so `putMessage` — called ~4× per turn and previously
 * re-parsing and rewriting the WHOLE conversation each time — costs one `stat` to read.
 * The on-disk shape is untouched. The crash-recovery transform still runs on EVERY
 * `loadThreads`, cache hit or not: a `streaming` placeholder this process just wrote is
 * read back `interrupted` exactly as it was before, because the transform is a property
 * of reading, not of parsing.
 */

/** The current thread-store schema version. Bumped on a breaking shape change. */
export const THREAD_STORE_VERSION = 1;

const threadFileSchema = z.object({
  version: z.number().int(),
  threads: z.array(persistedThreadSchema),
});
type ThreadFile = z.infer<typeof threadFileSchema>;

/** The default thread-store directory: `~/.rennet/threads`. Tests pass a temp dir. */
export function defaultThreadStoreDir(): string {
  return join(homedir(), ".rennet", "threads");
}

/**
 * Apply the crash-recovery transform to a thread: every `streaming` message becomes
 * `interrupted` (the process that was producing it is gone). Pure and total. This is
 * the one function whose removal lets a killed-mid-stream turn read back as still
 * streaming — the red-proof target.
 */
export function recoverInterruptedTurns(thread: PersistedThreadWire): PersistedThreadWire {
  let changed = false;
  const messages = thread.messages.map((message): PersistedThreadMessageWire => {
    if (message.status === "streaming") {
      changed = true;
      // An interrupted turn keeps NO fabricated answer — the streaming placeholder
      // carried no body, and it stays empty, flagged interrupted.
      return { ...message, status: "interrupted" };
    }
    return message;
  });
  return changed ? { ...thread, messages } : thread;
}

export class FileThreadStore {
  private tmpSeq = 0;
  private readonly cache = new ParsedFileCache<PersistedThreadWire[]>();

  constructor(private readonly dir: string = defaultThreadStoreDir()) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(reviewId: string): string {
    // The reviewId is opaque; encode it so a slash or odd char cannot escape the dir.
    return join(this.dir, `${encodeURIComponent(reviewId)}.json`);
  }

  /** The distinct on-disk state for a review's threads (absent / ok / malformed). A
   *  malformed file is never overwritten wholesale (Rule 75). */
  private readState(reviewId: string): {
    status: "absent" | "ok" | "malformed";
    file: ThreadFile;
  } {
    const empty: ThreadFile = { version: THREAD_STORE_VERSION, threads: [] };
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(reviewId), "utf8");
    } catch {
      return { status: "absent", file: empty };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "malformed", file: empty };
    }
    const result = threadFileSchema.safeParse(parsed);
    return result.success
      ? { status: "ok", file: result.data }
      : { status: "malformed", file: empty };
  }

  /** The memoized threads for a review, parsed from disk only when the cache misses.
   *  `malformed` is reported to the caller and never memoized. */
  private cachedThreads(reviewId: string): {
    threads: PersistedThreadWire[];
    malformed: boolean;
  } {
    const path = this.pathFor(reviewId);
    const hit = this.cache.get(path);
    if (hit !== undefined) return { threads: hit, malformed: false };
    const state = this.readState(reviewId);
    // An ABSENT file has nothing to stamp, so there is nothing to memoize against; that
    // read is already just an ENOENT, and the first write creates the file.
    if (state.status === "ok") this.cache.set(path, state.file.threads);
    return { threads: state.file.threads, malformed: state.status === "malformed" };
  }

  /**
   * Load the persisted threads for a review, WITH the crash-recovery transform applied
   * (every `streaming` message → `interrupted`). Missing/malformed ⇒ `[]` (fail-safe).
   */
  loadThreads(reviewId: string): PersistedThreadWire[] {
    // The transform runs per READ, not per parse: a `streaming` message this process
    // wrote a moment ago must still read back `interrupted`, cache hit or not.
    return this.cachedThreads(reviewId).threads.map(recoverInterruptedTurns);
  }

  private write(reviewId: string, threads: PersistedThreadWire[]): void {
    const path = this.pathFor(reviewId);
    const next: ThreadFile = { version: THREAD_STORE_VERSION, threads };
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
    // Write through: the file we just landed IS `threads`, so the next read serves it
    // from memory instead of re-parsing bytes this process produced.
    this.cache.set(path, threads);
  }

  /**
   * Ensure a thread exists (identity + anchor + harness version). New ⇒ appended with
   * no messages; existing ⇒ left as-is (identity is immutable, messages are not touched
   * here). Refuses on a malformed file rather than clobbering it.
   */
  upsertThread(
    reviewId: string,
    thread: {
      threadId: string;
      anchor: ConversationAnchorWire;
      harnessVersionAtCreation?: string;
    },
  ): void {
    const state = this.cachedThreads(reviewId);
    if (state.malformed) {
      throw new Error(`refusing to overwrite a malformed thread file for review ${reviewId}`);
    }
    if (state.threads.some((existing) => existing.threadId === thread.threadId)) return;
    const created: PersistedThreadWire = {
      threadId: thread.threadId,
      anchor: thread.anchor,
      ...(thread.harnessVersionAtCreation !== undefined
        ? { harnessVersionAtCreation: thread.harnessVersionAtCreation }
        : {}),
      messages: [],
    };
    this.write(reviewId, [...state.threads, created]);
  }

  /**
   * Put a message into a thread — append by id, or REPLACE the existing message with
   * the same id (a `streaming` placeholder replaced by its durable completion). A thread
   * that does not exist is a no-op (the caller upserts it first). Refuses on malformed.
   */
  putMessage(reviewId: string, threadId: string, message: PersistedThreadMessageWire): void {
    const state = this.cachedThreads(reviewId);
    if (state.malformed) {
      throw new Error(`refusing to overwrite a malformed thread file for review ${reviewId}`);
    }
    let touched = false;
    const threads = state.threads.map((thread) => {
      if (thread.threadId !== threadId) return thread;
      touched = true;
      const has = thread.messages.some((existing) => existing.id === message.id);
      const messages = has
        ? thread.messages.map((existing) => (existing.id === message.id ? message : existing))
        : [...thread.messages, message];
      return { ...thread, messages };
    });
    if (touched) this.write(reviewId, threads);
  }
}
