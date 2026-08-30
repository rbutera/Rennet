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

export class TranscriptStore {
  private tmpSeq = 0;

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

  /** Every persisted row for a session, in append order. Absent ⇒ `[]`; corrupt ⇒ THROW. */
  read(sessionId: string): SessionTranscriptRow[] {
    const state = this.readState(sessionId);
    if (state.status === "corrupt") {
      throw new TranscriptStoreCorruptError(sessionId, state.detail ?? "unknown");
    }
    return state.file.rows;
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
    const state = this.readState(sessionId);
    if (state.status === "corrupt") {
      throw new TranscriptStoreCorruptError(
        sessionId,
        `${state.detail ?? "unknown"} — refusing to append over unread history`,
      );
    }
    this.write(sessionId, [...state.file.rows, ...rows]);
  }

  /**
   * Append only rows whose stable ids are not already present. Round lifecycle rows use this
   * because terminal drain and daemon recovery are deliberately repeatable; replaying either
   * must not duplicate a user dispatch or orchestrator return in the display transcript.
   */
  appendUnique(sessionId: string, rows: readonly SessionTranscriptRow[]): void {
    if (rows.length === 0) return;
    const state = this.readState(sessionId);
    if (state.status === "corrupt") {
      throw new TranscriptStoreCorruptError(
        sessionId,
        `${state.detail ?? "unknown"} — refusing to append over unread history`,
      );
    }
    const known = new Set(state.file.rows.map((row) => row.id));
    const additions = rows.filter((row) => {
      if (known.has(row.id)) return false;
      known.add(row.id);
      return true;
    });
    if (additions.length === 0) return;
    this.write(sessionId, [...state.file.rows, ...additions]);
  }
}
