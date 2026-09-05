#!/usr/bin/env node
/**
 * Nx cache doctor.
 *
 * Nx 23 splits a cache entry across two stores:
 *
 *   - the artifact store, `cacheDir`, which holds the files a cache hit
 *     restores. It honours `NX_CACHE_DIRECTORY`.
 *   - the metadata database, in the workspace-data directory, which decides
 *     whether a task is a hit at all. In a git worktree Nx deliberately
 *     resolves it against the MAIN worktree so every lane shares one database,
 *     and it does NOT honour `NX_CACHE_DIRECTORY`.
 *
 * A hit is declared from the database alone; Nx never checks that the artifact
 * store still holds the bytes. So an entry whose files are gone reports
 * "[local cache] ... 100% hit", exits 0, and restores nothing — which is how
 * `t3code-server:build` came back green with no `dist/` and took
 * `rennet-desktop:build` down with it (issue #827).
 *
 * This script is the repair. `cache_outputs.size` records the exact number of
 * bytes Nx stored for an entry (its output tree plus its terminal-output file),
 * so an entry is restorable if and only if that many bytes are on disk in the
 * artifact store now. Anything else is deleted from the database, which turns a
 * silent wrong build back into an honest cache miss.
 *
 * Usage:
 *   node scripts/nx-cache-doctor.mjs            audit and repair
 *   node scripts/nx-cache-doctor.mjs --report   audit only, change nothing
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

/** Resolve the two stores exactly the way Nx does, by asking Nx. */
export function resolveStores(nx = loadNx()) {
  const root = nx.workspaceRoot;
  let mainRoot = root;
  try {
    mainRoot = nx.getMainWorktreeRoot(root) ?? root;
  } catch {
    // Worktree detection failed; Nx falls back to the local root and so do we.
  }
  return {
    artifacts: nx.cacheDir,
    data: nx.workspaceDataDirectoryForWorkspace(mainRoot),
  };
}

function loadNx() {
  const cacheDirectory = require("nx/src/utils/cache-directory.js");
  return {
    cacheDir: cacheDirectory.cacheDir,
    workspaceDataDirectoryForWorkspace: cacheDirectory.workspaceDataDirectoryForWorkspace,
    getMainWorktreeRoot: require("nx/src/native").getMainWorktreeRoot,
    workspaceRoot: require("nx/src/utils/workspace-root").workspaceRoot,
  };
}

/**
 * The two stores are paired when they sit under the same parent, which is how
 * Nx lays them out: `<root>/.nx/cache` beside `<root>/.nx/workspace-data`.
 * Setting `NX_CACHE_DIRECTORY` without `NX_WORKSPACE_DATA_DIRECTORY` (or the
 * reverse) breaks the pairing, and every entry the split run writes is a
 * booby trap for the next lane.
 */
export function storesArePaired({ artifacts, data }) {
  return dirname(artifacts) === dirname(data);
}

/** Total bytes of a file, or of a directory tree, or 0 when absent. */
export function bytesOnDisk(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += bytesOnDisk(join(path, entry));
  return total;
}

/** The bytes Nx stored for one entry: its output tree plus its terminal output. */
export function storedBytes(artifacts, hash) {
  return bytesOnDisk(join(artifacts, hash)) + bytesOnDisk(join(artifacts, "terminalOutputs", hash));
}

/** Every Nx metadata database in a workspace-data directory. */
export function findDatabases(dataDirectory) {
  if (!existsSync(dataDirectory)) return [];
  return readdirSync(dataDirectory)
    .filter((name) => name.endsWith(".db"))
    .sort()
    .map((name) => join(dataDirectory, name));
}

/**
 * Delete every cache entry the artifact store cannot restore.
 *
 * An entry survives only when its output directory is present AND the bytes on
 * disk match the byte count the database recorded. A missing directory is the
 * lane-cleanup case; a byte mismatch is a half-deleted entry. Both restore the
 * wrong thing, so both go.
 */
export function repairDatabase(databasePath, artifacts, { dryRun = false } = {}) {
  const db = new DatabaseSync(databasePath, { readOnly: dryRun });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const rows = db
      .prepare(
        "select c.hash as hash, c.size as size, d.project as project, d.target as target " +
          "from cache_outputs c join task_details d on d.hash = c.hash",
      )
      .all();
    const unrestorable = rows.filter(
      (row) =>
        !existsSync(join(artifacts, String(row.hash))) ||
        storedBytes(artifacts, String(row.hash)) !== Number(row.size),
    );
    if (!dryRun && unrestorable.length > 0) {
      const remove = db.prepare("delete from cache_outputs where hash = ?");
      db.exec("BEGIN");
      for (const row of unrestorable) remove.run(String(row.hash));
      db.exec("COMMIT");
    }
    return { checked: rows.length, unrestorable };
  } finally {
    db.close();
  }
}

function describe(entries) {
  const byTarget = new Map();
  for (const entry of entries) {
    const key = `${entry.project}:${entry.target}`;
    byTarget.set(key, (byTarget.get(key) ?? 0) + 1);
  }
  return [...byTarget.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([task, count]) => `${task} x${count}`)
    .join(", ");
}

function main(argv) {
  const dryRun = argv.includes("--report") || argv.includes("--dry-run");
  const stores = resolveStores();

  if (!storesArePaired(stores)) {
    process.stderr.write(
      [
        "Nx cache is split across two unrelated stores:",
        `  artifacts     ${stores.artifacts}`,
        `  metadata (db) ${stores.data}`,
        "",
        "Nx decides a cache hit from the metadata database and restores the files",
        "from the artifact store. The database ignores NX_CACHE_DIRECTORY and is",
        "shared with the main worktree, so setting one without the other makes Nx",
        "report hits it cannot restore — a green build with no dist/ (issue #827).",
        "",
        "Run the gate without NX_CACHE_DIRECTORY:",
        "  CI=true NX_DAEMON=false pnpm check",
        "",
        "If a lane really must isolate its cache, isolate both stores together:",
        '  NX_CACHE_DIRECTORY="$PWD/.nx-isolated/cache" \\',
        '  NX_WORKSPACE_DATA_DIRECTORY="$PWD/.nx-isolated/workspace-data"',
        "",
      ].join("\n"),
    );
    return 1;
  }

  const databases = findDatabases(stores.data);
  if (databases.length === 0) {
    process.stdout.write("nx-cache-doctor: no cache database yet, nothing to check\n");
    return 0;
  }

  let checked = 0;
  let unread = 0;
  const removed = [];
  for (const databasePath of databases) {
    let result;
    try {
      result = repairDatabase(databasePath, stores.artifacts, { dryRun });
    } catch (error) {
      // A live Nx process in another worktree holds this database. We have
      // learned nothing about the cache, so we say so and get out of the way
      // rather than failing a gate over a lock. The split case above is
      // different: there we know the run is unsafe.
      process.stderr.write(
        `nx-cache-doctor: could not read ${databasePath} (${error.message}). ` +
          "Another Nx process is probably using it; re-run `pnpm nx:doctor` once it exits.\n",
      );
      unread += 1;
      continue;
    }
    checked += result.checked;
    removed.push(...result.unrestorable);
  }

  const verb = dryRun ? "would drop" : "dropped";
  const note =
    unread > 0 ? `; ${unread} database${unread === 1 ? "" : "s"} unreadable, not checked` : "";
  if (checked === 0 && unread > 0) {
    process.stdout.write(
      `nx-cache-doctor: cache not checked, ${unread} database${unread === 1 ? "" : "s"} unreadable\n`,
    );
  } else if (removed.length === 0) {
    process.stdout.write(`nx-cache-doctor: ${checked} cache entries, all restorable${note}\n`);
  } else {
    process.stdout.write(
      `nx-cache-doctor: ${verb} ${removed.length} of ${checked} cache entries whose artifacts are missing from ${stores.artifacts} (${describe(removed)})${note}\n`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
