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
import { homedir } from "node:os";
import { join } from "node:path";
import { addThread, archive, attachReview } from "@rennet/core";
import {
  type SessionModel,
  SessionModelSchema,
  type SessionPreparation,
  type SessionThread,
} from "@rennet/protocol";

/**
 * The durable-session store (#466 res. 1–2, B09 cluster 1) — durability for the
 * first-class session so a chat survives the process that created it. One JSON
 * document per session at `~/.rennet/sessions/<sessionId>.json`, sibling to the
 * thread and project stores, written atomically (temp + rename) so a reader
 * never sees a half-written file. Follows the `file-thread-store`/
 * `file-project-store` precedent: same serialization, `SessionModelSchema.parse`
 * on read.
 *
 * The session owns its threads (`SessionThread[]`); thread CONTENT stays in the
 * transcript (`FileThreadStore`), this store holds only the session record with
 * its anchor→thread references. State transitions live in `@rennet/core`
 * (`mintSession`/`bindTarget`/`attachReview`/`addThread`/`archive`) — this store
 * is the I/O around that pure layer, not a second copy of it.
 *
 * FAIL-SAFE READ (Rule 75): a missing or malformed file resolves to `undefined`
 * (load) or is skipped (list), never a throw — a corrupt session file must
 * degrade to "not reattachable", not crash the front door. A malformed file is
 * LEFT UNTOUCHED so a human can recover it.
 */

/** The default session-store directory: `~/.rennet/sessions`. Tests pass a temp dir. */
export function defaultSessionStoreDir(): string {
  return join(homedir(), ".rennet", "sessions");
}

export interface SessionStoreDeps {
  /** The archive clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
}

export class SessionStore {
  private tmpSeq = 0;
  private readonly now: () => number;

  constructor(
    private readonly dir: string = defaultSessionStoreDir(),
    deps: SessionStoreDeps = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.now = deps.now ?? (() => Date.now());
  }

  private pathFor(sessionId: string): string {
    // The sessionId is opaque; encode it so a slash or odd char cannot escape the dir.
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  /** Load one session, WITH schema validation. Missing/malformed ⇒ `undefined` (fail-safe). */
  load(sessionId: string): SessionModel | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(sessionId), "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = SessionModelSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  }

  /** Persist a session atomically (temp + rename). Overwrites the record for its id. */
  save(session: SessionModel): void {
    const validated = SessionModelSchema.parse(session);
    const path = this.pathFor(validated.id);
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

  /** Every persisted session, newest first. Malformed entries are skipped, not thrown. */
  list(): SessionModel[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const sessions: SessionModel[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = decodeURIComponent(name.slice(0, -".json".length));
      const session = this.load(sessionId);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Archive a session — the only release (soft delete, `archivedAt`). Loads,
   * applies the pure `archive` transition, persists, and returns the archived
   * record; `undefined` if the session is absent. The record survives on disk.
   */
  archive(sessionId: string): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    const archived = archive(session, this.now);
    this.save(archived);
    return archived;
  }

  /**
   * RESTORE an archived session — un-archive is the inverse of the only release, so a
   * session the reviewer archived by accident comes back rather than being unreachable.
   * `undefined` if the session is absent; a live session is returned untouched.
   */
  restore(sessionId: string): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    if (session.archivedAt === undefined) return session;
    const restored = { ...session };
    delete restored.archivedAt;
    this.save(restored);
    return restored;
  }

  /**
   * Set the reviewer's own title for a session (C18 `session.rename`). An EMPTY title
   * CLEARS it, so the sidebar row falls back to the claimed branch — the same
   * restore-the-default rule an emptied project name follows. `undefined` if absent.
   */
  rename(sessionId: string, title: string): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    const next = { ...session };
    const trimmed = title.trim();
    if (trimmed === "") delete next.title;
    else next.title = trimmed;
    this.save(next);
    return next;
  }

  /** Pin/unpin a session to the top of its project group (C18). `undefined` if absent. */
  setPinned(sessionId: string, pinned: boolean): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    const next = { ...session };
    if (pinned) next.pinned = true;
    else delete next.pinned;
    this.save(next);
    return next;
  }

  /**
   * Attach a captured review to a session (#587) — the 1:0..1 reference the session model
   * declares. A session that ALREADY holds a review keeps it and is returned untouched: a
   * session attaches at most one review (`core`'s `attachReview` refuses a second), and the
   * New Chat front door only captures for a session with none, so re-pointing here would
   * only ever be a race rewriting history. `undefined` if the session is absent.
   */
  attachReview(sessionId: string, reviewId: string): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    if (session.reviewId !== undefined) return session;
    const next = attachReview(session, reviewId);
    this.save(next);
    return next;
  }

  /** Replace or clear the durable New Chat preparation snapshot. */
  setPreparation(
    sessionId: string,
    preparation: SessionPreparation | undefined,
  ): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    const next = { ...session };
    if (preparation === undefined) delete next.preparation;
    else next.preparation = preparation;
    this.save(next);
    return next;
  }

  /**
   * Append a thread reference to a session and persist it (#466 res. 7). Routes
   * through the pure `addThread` so the frozen `SessionThreadSchema` union is
   * enforced — an ask without an anchor is refused, not stored. Returns the
   * updated record; `undefined` if the session is absent.
   */
  addThread(sessionId: string, thread: SessionThread): SessionModel | undefined {
    const session = this.load(sessionId);
    if (!session) return undefined;
    const next = addThread(session, thread);
    this.save(next);
    return next;
  }
}
