// Session context files (session-context-files, design D3): the ONE writer and the ONE
// purge for `<bound root>/.rennet/context/<sessionId>/`.
//
// The rule this implements is "never inline context". Anything a turn needs beyond its
// instructions is written here as a file; the prompt names the path and the agent reads
// what it decides it needs with its own tools, exactly as it reads the checkout. Nothing
// else in the daemon creates or removes a directory under `.rennet/context/`.
//
// Three properties the callers depend on:
//
//   • It is under the BOUND ROOT, not under `~/.rennet`. A seat's tools resolve relative
//     to its cwd, so the files must sit in the same checkout it reads the diff from.
//   • It is never staged. `ensureManagedIgnoreBlock` puts `context/` in the repo's managed
//     `.rennet/.gitignore` BEFORE the first file lands, so a round's own commit in the
//     reviewer's checkout cannot pick it up.
//   • It is purged at ARCHIVE, not at generation settle — a reopened transcript or a
//     resumed round still finds its files. Four callers: `session.archive`, the round's
//     `sweepIfArchived` re-sweep, the daemon-start orphan sweep below, and the scout
//     runtime, whose run-scoped directory has no archive to be purged at.
//
// Every directory carries an `.owner` file naming the daemon INCARNATION that wrote it —
// its data dir, its pid and its start time — because a second daemon over the same repo
// reads a live session's directory as an orphan otherwise and deletes it mid-turn. The
// data dir alone was not enough: two daemons can share one (a dev run pointed at the
// packaged app's `~/.rennet`), and then each reads the other's live directories as its
// own (review finding 3). The sweep reclaims a directory only when its incarnation is
// THIS process, or when that process is provably gone.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureManagedIgnoreBlock } from "@rennet/adapters";
import { type SessionContextFile, sessionContextRelativeDir } from "@rennet/core";
import type { ProjectVisibility } from "@rennet/protocol";

/** The stamp naming the daemon that wrote a context directory. Never in the index. */
const OWNER_FILE = ".owner";

/**
 * The two process-level facts the writer needs and no call site can answer.
 *
 * `owner` is WHICH daemon is writing — its data dir. `visibilityOf` is what the repo's
 * `.rennet/` exclusion is set to, so ensuring the ignore block cannot undo a `git-visible`
 * switch (review finding 1). Both are properties of the running daemon, not of a call, so
 * the composition root sets them once with {@link configureSessionContext} rather than
 * threading a store handle through every writer.
 */
export interface SessionContextHost {
  /** The writing daemon's data dir, stamped as `.owner`. */
  readonly owner: string;
  /** The repository's recorded visibility. */
  readonly visibilityOf: (repoRoot: string) => ProjectVisibility;
}

/** What a daemon that never announced itself gets: the default data dir, local visibility. */
let host: SessionContextHost = {
  owner: join(homedir(), ".rennet"),
  visibilityOf: () => "local",
};

/** Name the running daemon (its data dir) and how to read a repo's visibility. Called once. */
export function configureSessionContext(next: SessionContextHost): void {
  host = next;
}

/**
 * This process's identity, as the `.owner` stamp records it: the data dir, the pid, and
 * the process start time in epoch millis.
 *
 * The pid is what makes a foreign incarnation FALSIFIABLE — a directory whose pid no
 * longer resolves to a running process is provably abandoned, and one whose pid is alive
 * is provably not ours to delete. The start time is recorded so a reader can tell a
 * recycled pid apart from the original; it is not consulted, because no portable call
 * reads another process's start time (see `isProcessAlive`).
 */
interface DaemonIncarnation {
  readonly dataDir: string;
  readonly pid: number;
  readonly startedAt: number;
}

/** Rounded to the second: `uptime()` drifts in the sub-second digits between reads. */
const PROCESS_STARTED_AT = Math.round((Date.now() - process.uptime() * 1000) / 1000) * 1000;

function thisIncarnation(): DaemonIncarnation {
  return { dataDir: host.owner, pid: process.pid, startedAt: PROCESS_STARTED_AT };
}

/** The `.owner` body: three tab-separated fields on one line. */
function stampOf(incarnation: DaemonIncarnation): string {
  return `${incarnation.dataDir}\t${incarnation.pid}\t${incarnation.startedAt}\n`;
}

/**
 * Parse an `.owner` stamp. `undefined` for an unreadable file, and for a stamp written
 * before this format existed (a bare data dir) — an unknown incarnation is LEFT ALONE,
 * which is the only safe reading of "I cannot tell whose this is".
 */
function ownerOf(dir: string): DaemonIncarnation | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, OWNER_FILE), "utf8").trim();
  } catch {
    return undefined;
  }
  const [dataDir, pid, startedAt] = raw.split("\t");
  if (dataDir === undefined || pid === undefined || startedAt === undefined) return undefined;
  const parsedPid = Number(pid);
  const parsedStart = Number(startedAt);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0 || !Number.isFinite(parsedStart)) {
    return undefined;
  }
  return { dataDir, pid: parsedPid, startedAt: parsedStart };
}

/**
 * Whether a pid resolves to a running process. Signal 0 checks existence without
 * delivering anything; `EPERM` means it exists under another user, which is still alive.
 *
 * ponytail: pid liveness only, no start-time cross-check — the OS gives no portable way to
 * read another process's start time, so a recycled pid reads as alive and its directory is
 * left rather than reclaimed. Leaving a dead daemon's directory costs a sweep; deleting a
 * live one costs a turn. The next start of the daemon that owns it reclaims it as its own.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The file SHAPE and the RELATIVE path live in `@rennet/core`, because the node-free
// prompt builders that name these files must agree with this writer byte for byte — a
// prompt naming a path the writer does not create is a turn that reads nothing.
export type { SessionContextFile };

/** The session's context directory under a bound root. Not created by this call. */
export function sessionContextDir(root: string, sessionId: string): string {
  return join(root, sessionContextRelativeDir(sessionId));
}

/** An index entry, so a re-render can tell one apart from the prose around it. */
const INDEX_ENTRY = /^- `([^`]+)` — /;

/**
 * The `README.md` index: one line per file — name, what it holds, when to read it.
 *
 * Entries from EARLIER writes are carried forward. Several turn kinds write into one
 * session's directory at different moments (a seat's context, then a verification turn's
 * pointers), and each write re-renders this file; without the carry-forward the last
 * writer's index would omit files whose prompts still name them — a directory listing
 * that lies about its own directory.
 */
function renderIndex(dir: string, files: readonly SessionContextFile[]): string {
  const written = new Set(files.map((file) => file.name));
  let kept: readonly string[] = [];
  try {
    kept = readFileSync(join(dir, "README.md"), "utf8")
      .split("\n")
      .filter((line) => {
        const name = INDEX_ENTRY.exec(line)?.[1];
        return name !== undefined && !written.has(name);
      });
  } catch {
    // No index yet (the first write into this directory), or it is unreadable.
  }
  const lines = [
    ...kept,
    ...files.map((file) => `- \`${file.name}\` — ${file.holds} Read it ${file.readWhen}`),
  ].sort();
  return [
    "# Session context",
    "",
    "The files this session's turns may read. Nothing here was sent to you inline: read a",
    "file when the line below says to, with your own tools, the way you read the checkout.",
    "",
    ...(lines.length === 0 ? ["(no files)"] : lines),
    "",
  ].join("\n");
}

// The relative path has ONE definition, in `@rennet/core`, so the node-free prompt
// builders and this writer cannot drift; re-exported here for the daemon's own callers.
export { sessionContextRelativeDir };

/**
 * The session's context directory, created, ignored, and stamped with this daemon's
 * identity. Every writer in this module goes through it, so no directory can exist without
 * the `.owner` the sweep matches on.
 */
function ensureContextDir(root: string, sessionId: string): string {
  // Before the first write, never after: a file that lands ahead of the ignore entry is a
  // file the reviewer's next `git add -A` stages. At the repo's OWN visibility, so this
  // cannot re-ignore derived data on a repo the reviewer set to `git-visible`.
  ensureManagedIgnoreBlock(root, host.visibilityOf(root));
  const dir = sessionContextDir(root, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OWNER_FILE), stampOf(thisIncarnation()));
  return dir;
}

/**
 * Write this session's context files and their index, ensuring the managed ignore block
 * first. Idempotent per file: a re-write replaces the body, and the index is re-rendered
 * from these files plus every entry an earlier write left. Returns the directory it wrote
 * into.
 */
export function writeSessionContext(
  root: string,
  sessionId: string,
  files: readonly SessionContextFile[],
): string {
  const dir = ensureContextDir(root, sessionId);
  for (const file of files) {
    const path = join(dir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
  }
  writeFileSync(join(dir, "README.md"), renderIndex(dir, files));
  return dir;
}

/**
 * One RUN-SCOPED file under the session's directory, plus the discard that removes it
 * (review finding 3).
 *
 * For a payload that exists only for the turn now reading it — the related-context
 * candidate dossier is the case this was written for. It lives under the session
 * directory so the archive purge covers it even when the turn never returns, and its name
 * is the caller's to make unique, so a concurrent retrieval on the same target cannot
 * overwrite the file the first one's seat is reading.
 *
 * Deliberately NOT in the `README.md` index: the index tells a turn what it will find, and
 * a line naming a file the next turn will not find is a lie. `discard` is idempotent.
 *
 * `path` is RELATIVE to the bound root and `/`-separated, because that string is what a
 * prompt names and what the seat opens. The absolute path is the daemon's own locus and
 * would be unreadable from a WSL seat's distro cwd (review finding 4); `join`'s Windows
 * backslashes are wrong in a prompt for the same reason.
 */
export function writeRunScopedContext(
  root: string,
  sessionId: string,
  name: string,
  body: string,
): { readonly path: string; discard(): void } {
  const absolute = join(ensureContextDir(root, sessionId), name);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
  return {
    path: `${sessionContextRelativeDir(sessionId)}/${name}`,
    discard: () => {
      rmSync(absolute, { force: true });
    },
  };
}

/**
 * Remove this session's context directory. Never throws for an absent directory — the
 * ordinary case is a session that never had one, and an archive the reviewer asked for
 * may not fail on scratch cleanup. Returns whether a directory was actually removed.
 */
export function purgeSessionContext(root: string, sessionId: string): boolean {
  const dir = sessionContextDir(root, sessionId);
  const existed = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return existed;
}

/**
 * The archive-time purge, and every turn that may still be reading (review findings 2/4).
 *
 * `session.archive` aborts and awaits the session's PREPARATION, but nothing else in the
 * daemon is awaited there: a round is driven by the durable coordinator, and the opener,
 * the PR-body draft, the compose turn, the handoff run, verification, refine, CI
 * classification, noise, the scout and related-context retrieval are all plain in-flight
 * promises. An archive landing during any of them used to delete the directory the seat
 * was in the middle of reading. #773's `sweepIfArchived` re-sweep only catches what a
 * round writes AFTER the purge, which is not the same thing, and it only covers rounds.
 *
 * So the purge takes a LEASE, not a round flag. Every turn that consumes context files
 * holds one from before its context write until it settles; a purge that arrives while any
 * lease is held is REMEMBERED and performed by the last release. A live session is
 * unaffected — nothing purges it at all — and an archived one loses its directory the
 * moment the last reader lets go.
 */
export interface SessionContextPurger {
  /**
   * Purge now unless a turn still holds a lease, in which case the purge is remembered and
   * the last release performs it. Returns whether a directory was removed BY THIS CALL.
   */
  purge(sessionId: string): boolean;
  /**
   * Hold this session's context for the life of one turn; call the returned release when
   * the turn settles (success, failure or throw). Idempotent.
   */
  turnInFlight(sessionId: string): () => void;
}

export function createSessionContextPurger(
  /** The session's bound root, or `undefined` when nothing recorded one. */
  rootFor: (sessionId: string) => string | undefined,
): SessionContextPurger {
  // Counted, not a flag: turns overlap on one session — a round and a refine, two
  // verification legs — and the first to settle must not declare the directory free while
  // the second is still reading it.
  const inFlight = new Map<string, number>();
  // Sessions whose archive asked for a purge while a lease was held. The last release
  // drains this; without it a deferred purge is simply a purge that never happens, and the
  // archived session's files sit in the reviewer's checkout until a daemon restart.
  const deferred = new Set<string>();
  const purgeNow = (sessionId: string): boolean => {
    const root = rootFor(sessionId);
    return root === undefined ? false : purgeSessionContext(root, sessionId);
  };
  return {
    purge(sessionId) {
      if ((inFlight.get(sessionId) ?? 0) > 0) {
        deferred.add(sessionId);
        return false;
      }
      deferred.delete(sessionId);
      return purgeNow(sessionId);
    },
    turnInFlight(sessionId) {
      inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return; // idempotent: a double release must not free a live turn
        released = true;
        const next = (inFlight.get(sessionId) ?? 1) - 1;
        if (next > 0) {
          inFlight.set(sessionId, next);
          return;
        }
        inFlight.delete(sessionId);
        if (deferred.delete(sessionId)) purgeNow(sessionId);
      };
    },
  };
}

/** What the daemon-start sweep needs to know about the session store. */
export interface SessionContextSweepStore {
  /**
   * Every id the store has a FILE for — the raw persisted ids, not the parsed list. A
   * malformed record is skipped by `list()`, and reading a directory as orphaned because
   * its record would not parse deletes a live session's files while the silence reads as
   * proof it was gone (review finding 2).
   */
  readonly persistedIds: ReadonlySet<string>;
  /**
   * Ids the store marks ARCHIVED. A crash between `setArchived` and the purge leaves the
   * record in the store, so the directory is neither orphaned nor ever purged again; the
   * next start owes it (review finding 7).
   */
  readonly archivedIds: ReadonlySet<string>;
}

/**
 * The daemon-start orphan sweep: remove every `<root>/.rennet/context/<id>` THIS DAEMON
 * WROTE whose session is gone from the store or archived in it, across the roots it knows.
 *
 * Two positive contradictions, and nothing else is grounds for a delete:
 *
 *   • the id is absent from the store's raw persisted ids (a crash before archive), or
 *   • the store marks it archived (a crash between `setArchived` and the purge).
 *
 * Ownership is checked FIRST, and it is an INCARNATION, not a data dir. A second daemon
 * over the same repo has its own session store, in which every one of the other daemon's
 * live sessions is absent; without a stamp it deletes their directories mid-turn. Matching
 * on the data dir alone did not stop that when the two daemons SHARE a data dir — each
 * read the other's live directories as its own (review finding 3). So a directory is
 * reclaimed only when:
 *
 *   • it carries this exact incarnation (this data dir, this pid, this start) — the
 *     ordinary case, our own crash-orphaned directories; or
 *   • it carries a DEAD incarnation of this data dir — the pid resolves to no process, so
 *     the daemon that wrote it is provably gone.
 *
 * Everything else is LEFT and said so in the log: another data dir's directory, a LIVE
 * process's (the shared-data-dir case), and an unparseable or pre-format stamp. Never
 * throws: an unreadable root is skipped.
 */
export function sweepOrphanedSessionContext(
  roots: readonly string[],
  store: SessionContextSweepStore,
  log: (message: string) => void = console.info,
): number {
  const mine = thisIncarnation();
  let removed = 0;
  let foreign = 0;
  for (const root of new Set(roots)) {
    const parent = join(root, ".rennet", "context");
    let entries: readonly string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue; // no context directory in this root, or it is unreadable
    }
    for (const entry of entries) {
      const dir = join(parent, entry);
      if (!reclaimable(ownerOf(dir), mine)) {
        foreign += 1;
        continue;
      }
      if (store.persistedIds.has(entry) && !store.archivedIds.has(entry)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // A directory we cannot remove is left for the next start, never fatal.
      }
    }
  }
  if (removed > 0)
    log(`rennet: swept ${removed} orphaned session context director${removed === 1 ? "y" : "ies"}`);
  if (foreign > 0)
    log(
      `rennet: left ${foreign} session context director${foreign === 1 ? "y" : "ies"} this daemon does not own (another data dir, a live sibling process, or an unreadable stamp)`,
    );
  return removed;
}

/**
 * Whether this daemon may reclaim a directory carrying `owner`: its own incarnation, or a
 * dead one of its own data dir. An unknown stamp, another data dir's, and a LIVE sibling's
 * are all refusals — a directory a running process may be reading is never ours to delete.
 */
function reclaimable(
  owner: DaemonIncarnation | undefined,
  mine: DaemonIncarnation,
): owner is DaemonIncarnation {
  if (owner === undefined || owner.dataDir !== mine.dataDir) return false;
  if (owner.pid === mine.pid && owner.startedAt === mine.startedAt) return true;
  return !isProcessAlive(owner.pid);
}
