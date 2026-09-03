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
//     resumed round still finds its files. Three callers: `session.archive`, the round's
//     `sweepIfArchived` re-sweep, and the daemon-start orphan sweep below.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureManagedIgnoreBlock } from "@rennet/adapters";

/** One file in a session's context directory, with the two lines its index entry needs. */
export interface SessionContextFile {
  /** Path relative to the session's context directory; may name a subdirectory (`boards/design.json`). */
  readonly name: string;
  readonly body: string;
  /** One line: what this file holds. */
  readonly holds: string;
  /** One line: when a turn should read it. */
  readonly readWhen: string;
}

/** The session's context directory under a bound root. Not created by this call. */
export function sessionContextDir(root: string, sessionId: string): string {
  return join(root, ".rennet", "context", sessionId);
}

/** The `README.md` index: one line per file — name, what it holds, when to read it. */
function renderIndex(files: readonly SessionContextFile[]): string {
  const lines = files.map((file) => `- \`${file.name}\` — ${file.holds} Read it ${file.readWhen}`);
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

/**
 * Write this session's context files and their index, ensuring the managed ignore block
 * first. Idempotent per file: a re-write replaces the body and re-renders the index for
 * exactly the files it was given. Returns the directory it wrote into.
 */
export function writeSessionContext(
  root: string,
  sessionId: string,
  files: readonly SessionContextFile[],
): string {
  // Before the first write, never after: a file that lands ahead of the ignore entry is a
  // file the reviewer's next `git add -A` stages.
  ensureManagedIgnoreBlock(root);
  const dir = sessionContextDir(root, sessionId);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const path = join(dir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
  }
  writeFileSync(join(dir, "README.md"), renderIndex(files));
  return dir;
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
 * The daemon-start orphan sweep: remove every `<root>/.rennet/context/<id>` whose session
 * id the store no longer holds, across the roots the daemon knows.
 *
 * A crash between a write and an archive leaves a directory nobody will ever purge, so the
 * start that follows collects them. Matching is on a POSITIVE contradiction — the id is
 * absent from the session store — so a root the daemon happens not to know about this start
 * simply is not swept, rather than having a live session's files deleted under it. Never
 * throws: an unreadable root is skipped.
 */
export function sweepOrphanedSessionContext(
  roots: readonly string[],
  knownSessionIds: ReadonlySet<string>,
  log: (message: string) => void = console.info,
): number {
  let removed = 0;
  for (const root of new Set(roots)) {
    const parent = join(root, ".rennet", "context");
    let entries: readonly string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue; // no context directory in this root, or it is unreadable
    }
    for (const entry of entries) {
      if (knownSessionIds.has(entry)) continue;
      try {
        rmSync(join(parent, entry), { recursive: true, force: true });
        removed += 1;
      } catch {
        // A directory we cannot remove is left for the next start, never fatal.
      }
    }
  }
  if (removed > 0)
    log(`rennet: swept ${removed} orphaned session context director${removed === 1 ? "y" : "ies"}`);
  return removed;
}
