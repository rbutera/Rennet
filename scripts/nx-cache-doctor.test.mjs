import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { findDatabases, repairDatabase, storedBytes, storesArePaired } from "./nx-cache-doctor.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Build a miniature copy of an Nx local cache: an artifact store laid out the
 * way Nx lays it out, and a metadata database carrying Nx's two tables.
 */
function fixture(entries) {
  const root = mkdtempSync(join(tmpdir(), "rennet-nx-cache-doctor-"));
  roots.push(root);
  const artifacts = join(root, ".nx", "cache");
  const data = join(root, ".nx", "workspace-data");
  mkdirSync(join(artifacts, "terminalOutputs"), { recursive: true });
  mkdirSync(data, { recursive: true });

  const databasePath = join(data, "fixture-v3.db");
  const db = new DatabaseSync(databasePath);
  db.exec(
    "create table task_details (hash TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, target TEXT NOT NULL, configuration TEXT)",
  );
  db.exec(
    "create table cache_outputs (hash TEXT PRIMARY KEY NOT NULL, code INTEGER NOT NULL, size INTEGER NOT NULL, FOREIGN KEY (hash) REFERENCES task_details (hash))",
  );

  for (const entry of entries) {
    writeFileSync(join(artifacts, "terminalOutputs", entry.hash), entry.terminal);
    if (entry.output !== undefined) {
      mkdirSync(join(artifacts, entry.hash, "dist"), { recursive: true });
      writeFileSync(join(artifacts, entry.hash, "dist", "bin.mjs"), entry.output);
    }
    db.prepare("insert into task_details values (?, ?, ?, null)").run(
      entry.hash,
      entry.project,
      entry.target,
    );
    db.prepare("insert into cache_outputs values (?, 0, ?)").run(
      entry.hash,
      entry.recordedSize ?? entry.terminal.length + (entry.output?.length ?? 0),
    );
  }
  db.close();
  return { root, artifacts, data, databasePath };
}

function survivingHashes(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare("select hash from cache_outputs order by hash")
      .all()
      .map((row) => String(row.hash));
  } finally {
    db.close();
  }
}

describe("nx cache doctor", () => {
  it("keeps an entry whose bytes are all present", () => {
    const { artifacts, databasePath } = fixture([
      {
        hash: "keep",
        project: "t3code-server",
        target: "build",
        terminal: "ok\n",
        output: "bundle",
      },
    ]);
    const result = repairDatabase(databasePath, artifacts);
    assert.deepEqual(result.unrestorable, []);
    assert.deepEqual(survivingHashes(databasePath), ["keep"]);
  });

  it("drops an entry whose output directory was deleted", () => {
    // The reported failure: a lane wrote this entry, the lane's artifact
    // store was removed, the shared database kept the row, and the next
    // worktree got a 100% cache hit that restored no dist/.
    const { artifacts, databasePath } = fixture([
      { hash: "keep", project: "t3code-web", target: "build", terminal: "ok\n", output: "bundle" },
      {
        hash: "gone",
        project: "t3code-server",
        target: "build",
        terminal: "ok\n",
        recordedSize: 28_960_840,
      },
    ]);
    const result = repairDatabase(databasePath, artifacts);
    assert.deepEqual(
      result.unrestorable.map((row) => row.hash),
      ["gone"],
    );
    assert.deepEqual(survivingHashes(databasePath), ["keep"]);
  });

  it("drops an entry that is only partly on disk", () => {
    const { artifacts, databasePath } = fixture([
      {
        hash: "short",
        project: "t3code-server",
        target: "build",
        terminal: "ok\n",
        output: "half",
        recordedSize: 9999,
      },
    ]);
    repairDatabase(databasePath, artifacts);
    assert.deepEqual(survivingHashes(databasePath), []);
  });

  it("keeps an output-less entry, whose bytes are its terminal output alone", () => {
    // lint and typecheck store no files; Nx still creates the entry
    // directory, and its recorded size is the terminal output only.
    const { artifacts, databasePath } = fixture([
      { hash: "lint", project: "rennet-core", target: "lint", terminal: "no issues\n" },
    ]);
    mkdirSync(join(artifacts, "lint"), { recursive: true });
    assert.equal(storedBytes(artifacts, "lint"), "no issues\n".length);
    repairDatabase(databasePath, artifacts);
    assert.deepEqual(survivingHashes(databasePath), ["lint"]);
  });

  it("changes nothing when asked to report", () => {
    const { artifacts, databasePath } = fixture([
      {
        hash: "gone",
        project: "t3code-server",
        target: "build",
        terminal: "ok\n",
        recordedSize: 4242,
      },
    ]);
    const result = repairDatabase(databasePath, artifacts, { dryRun: true });
    assert.equal(result.unrestorable.length, 1);
    assert.deepEqual(survivingHashes(databasePath), ["gone"]);
  });

  it("finds the databases Nx writes beside each other", () => {
    const { data, databasePath } = fixture([]);
    writeFileSync(join(data, "project-graph.json"), "{}");
    assert.deepEqual(findDatabases(data), [databasePath]);
    assert.deepEqual(findDatabases(join(data, "absent")), []);
  });

  it("calls the stores paired only when they share a parent", () => {
    assert.equal(
      storesArePaired({ artifacts: "/repo/.nx/cache", data: "/repo/.nx/workspace-data" }),
      true,
    );
    // The shape that produced issue #827: NX_CACHE_DIRECTORY set in a
    // worktree while the database stayed with the main checkout.
    assert.equal(
      storesArePaired({
        artifacts: "/repo/.claude/worktrees/lane/.nx-isolated/cache",
        data: "/repo/.nx/workspace-data",
      }),
      false,
    );
  });
});
