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
// Every directory carries an `.owner` file naming the data dir of the daemon that wrote
// it, because a second daemon over the same repo (a dev daemon beside the packaged app,
// an isolated data dir) reads a live session's directory as an orphan otherwise and
// deletes it mid-turn. The sweep removes only what it owns.

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
  writeFileSync(join(dir, OWNER_FILE), `${host.owner}\n`);
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
 */
export function writeRunScopedContext(
  root: string,
  sessionId: string,
  name: string,
  body: string,
): { readonly path: string; discard(): void } {
  const path = join(ensureContextDir(root, sessionId), name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return {
    path,
    discard: () => {
      rmSync(path, { force: true });
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
 * The archive-time purge, and the rounds that may still be writing (review finding 4).
 *
 * `session.archive` aborts and awaits the session's PREPARATION, but a round is driven by
 * the durable coordinator and takes no abort signal, so an archive during a round used to
 * delete the directory the round's very next turn reads. #773's `sweepIfArchived` re-sweep
 * only catches what the round writes AFTER the purge, which is not the same thing.
 *
 * So the purge is DEFERRED while a round is in flight, and the round's own settle path —
 * which runs `sweepIfArchived` after clearing its flight — performs it. A live session is
 * unaffected: nothing purges it at all.
 */
export interface SessionContextPurger {
  /** Purge now unless a round is still writing. Returns whether a directory was removed. */
  purge(sessionId: string): boolean;
  /** Mark a round in flight for this session; call the returned settle when it finishes. */
  roundInFlight(sessionId: string): () => void;
}

export function createSessionContextPurger(
  /** The session's bound root, or `undefined` when nothing recorded one. */
  rootFor: (sessionId: string) => string | undefined,
): SessionContextPurger {
  // Counted, not a flag: two rounds can overlap on one session and the first to settle
  // must not declare the directory free while the second is still reading it.
  const inFlight = new Map<string, number>();
  return {
    purge(sessionId) {
      if ((inFlight.get(sessionId) ?? 0) > 0) return false;
      const root = rootFor(sessionId);
      return root === undefined ? false : purgeSessionContext(root, sessionId);
    },
    roundInFlight(sessionId) {
      inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1);
      let settled = false;
      return () => {
        if (settled) return; // idempotent: a settle called twice must not free a live round
        settled = true;
        const next = (inFlight.get(sessionId) ?? 1) - 1;
        if (next > 0) inFlight.set(sessionId, next);
        else inFlight.delete(sessionId);
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
 * Ownership is checked FIRST. A second daemon over the same repo — a dev daemon beside the
 * packaged app, any isolated data dir — has its own session store, in which every one of
 * the other daemon's live sessions is absent; without the `.owner` stamp it deletes their
 * directories mid-turn. An unknown owner (another daemon's, or a directory written before
 * the stamp existed) is LEFT, and said so in the log. Never throws: an unreadable root is
 * skipped.
 */
export function sweepOrphanedSessionContext(
  roots: readonly string[],
  store: SessionContextSweepStore,
  log: (message: string) => void = console.info,
): number {
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
      if (ownerOf(dir) !== host.owner) {
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
      `rennet: left ${foreign} session context director${foreign === 1 ? "y" : "ies"} written by another daemon`,
    );
  return removed;
}

/** The daemon that wrote a context directory, or `undefined` when unstamped/unreadable. */
function ownerOf(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, OWNER_FILE), "utf8").trim();
  } catch {
    return undefined;
  }
}
