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
import { type SessionTranscriptRow, SessionTranscriptRowSchema } from "@rennet/protocol";
import { z } from "zod";
import { ParsedFileCache } from "./parsed-file-cache";

/**
 * The durable session-transcript store (issue-set B). A per-session APPEND LOG of the
 * projected coding-turn rows the dock renders — a DISPLAY read-model, sibling to the
 * session/ask stores at `~/.rennet/transcripts/<sessionId>.json`, written atomically
 * (temp + fsync + rename + dir-fsync) so a reader never sees a half-written file.
 *
 * It holds a projection, not the canonical conversation: the harness CLI still owns the
 * transcript and resume rides the `HarnessCursor` (#466 res. 3). Rows are ALREADY R19-
 * scrubbed by the projector before they reach `append` — this store neither scrubs nor
 * projects, it only persists and reads back.
 *
 * ABSENT vs CORRUPT (the ask-log-store precedent): a MISSING file (ENOENT) is the honest
 * empty state — a session with no coding turns yet reads back `[]`, no error. A file that
 * EXISTS but cannot be trusted (IO/permission error, malformed JSON, schema mismatch, wrong
 * version) is unread history we refuse to silently drop, so `read` THROWS and `append`
 * REFUSES rather than clobbering it. Never fabricate rows to look present; never fold real
 * rows away to look empty.
 *
 * IN-MEMORY ROWS (perf audit §4 H4). The parsed rows are memoized per session path through
 * {@link ParsedFileCache}, and `appendUnique` keeps the id set beside them, so an append
 * costs one `stat` instead of a full read + zod walk + Set rebuild. The write itself is
 * unchanged — same document, same two fsyncs, same rename.
 */

/** The current transcript-store schema version. Bumped on a breaking row-shape change. */
export const TRANSCRIPT_STORE_VERSION = 1;

/** A session's transcript log exists but cannot be trusted (corrupt/incomplete). */
export class TranscriptStoreCorruptError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`transcript for session ${sessionId} is unreadable/corrupt: ${detail}`);
    this.name = "TranscriptStoreCorruptError";
  }
}

const transcriptFileSchema = z.object({
  version: z.number().int(),
  rows: z.array(SessionTranscriptRowSchema),
});
type TranscriptFile = z.infer<typeof transcriptFileSchema>;

/** The default transcript-store directory: `~/.rennet/transcripts`. Tests pass a temp dir. */
export function defaultTranscriptStoreDir(): string {
  return join(homedir(), ".rennet", "transcripts");
}

/** The memoized parse of one transcript file: its rows and, once `appendUnique` asked,
 *  the set of ids already present. */
interface CachedTranscript {
  rows: SessionTranscriptRow[];
  ids: Set<string> | undefined;
}

export class TranscriptStore {
  private tmpSeq = 0;
  private readonly cache = new ParsedFileCache<CachedTranscript>();

  constructor(private readonly dir: string = defaultTranscriptStoreDir()) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    // The sessionId is opaque; encode it so a slash or odd char cannot escape the dir.
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  private readState(sessionId: string): {
    status: "absent" | "ok" | "corrupt";
    file: TranscriptFile;
    detail?: string;
  } {
    const empty: TranscriptFile = { version: TRANSCRIPT_STORE_VERSION, rows: [] };
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(sessionId), "utf8");
    } catch (err) {
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
    const result = transcriptFileSchema.safeParse(parsed);
    if (!result.success) {
      return { status: "corrupt", file: empty, detail: "schema mismatch" };
    }
    if (result.data.version !== TRANSCRIPT_STORE_VERSION) {
      return {
        status: "corrupt",
        file: empty,
        detail: `unknown store version ${result.data.version} (expected ${TRANSCRIPT_STORE_VERSION})`,
      };
    }
    return { status: "ok", file: result.data };
  }

  /** The memoized transcript for a session, parsed from disk only when the cache misses.
   *  A corrupt file throws with `suffix` on the detail and is never memoized. */
  private cachedTranscript(sessionId: string, suffix = ""): CachedTranscript {
    const path = this.pathFor(sessionId);
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    const state = this.readState(sessionId);
    if (state.status === "corrupt") {
      throw new TranscriptStoreCorruptError(sessionId, `${state.detail ?? "unknown"}${suffix}`);
    }
    const entry: CachedTranscript = { rows: state.file.rows, ids: undefined };
    // An ABSENT file has nothing to stamp; that read is already just an ENOENT.
    if (state.status === "ok") this.cache.set(path, entry);
    return entry;
  }

  /** Every persisted row for a session, in append order. Absent ⇒ `[]`; corrupt ⇒ THROW. */
  read(sessionId: string): SessionTranscriptRow[] {
    // A copy: the array is memoized, and a caller must not be able to edit store state.
    return [...this.cachedTranscript(sessionId).rows];
  }

  private write(sessionId: string, rows: SessionTranscriptRow[]): void {
    const path = this.pathFor(sessionId);
    const next: TranscriptFile = { version: TRANSCRIPT_STORE_VERSION, rows };
    const tmp = `${path}.tmp-${process.pid}-${this.tmpSeq++}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dirFd = openSync(this.dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /**
   * Append a turn's projected rows to a session's log. Additive: prior rows are preserved,
   * the new ones land last. A no-op for an empty batch. Refuses on a corrupt file rather than
   * clobbering unread history.
   */
  append(sessionId: string, rows: readonly SessionTranscriptRow[]): void {
    if (rows.length === 0) return;
    const cached = this.cachedTranscript(sessionId, " — refusing to append over unread history");
    this.commit(sessionId, cached, [...rows]);
  }

  /**
   * Append only rows whose stable ids are not already present. Round lifecycle rows use this
   * because terminal drain and daemon recovery are deliberately repeatable; replaying either
   * must not duplicate a user dispatch or orchestrator return in the display transcript.
   */
  appendUnique(sessionId: string, rows: readonly SessionTranscriptRow[]): void {
    if (rows.length === 0) return;
    const cached = this.cachedTranscript(sessionId, " — refusing to append over unread history");
    // The id set is built once per parse and carried forward across appends, rather than
    // rebuilt from every row on each call.
    cached.ids ??= new Set(cached.rows.map((row) => row.id));
    const known = cached.ids;
    // Intra-batch duplicates are caught by a SEPARATE set, so a write that throws leaves
    // the memoized id set describing exactly what is on disk — a retry still sees the rows
    // as new. `commit` is the only place ids join the durable set.
    const batch = new Set<string>();
    const additions = rows.filter((row) => {
      if (known.has(row.id) || batch.has(row.id)) return false;
      batch.add(row.id);
      return true;
    });
    if (additions.length === 0) return;
    this.commit(sessionId, cached, additions);
  }

  /** Land `additions` after `cached`'s rows and memoize the result — the file we just
   *  wrote IS that state, so the next read serves it without re-parsing our own bytes. */
  private commit(
    sessionId: string,
    cached: CachedTranscript,
    additions: SessionTranscriptRow[],
  ): void {
    const next = [...cached.rows, ...additions];
    this.write(sessionId, next);
    const ids = cached.ids;
    if (ids !== undefined) for (const row of additions) ids.add(row.id);
    this.cache.set(this.pathFor(sessionId), { rows: next, ids });
  }
}
