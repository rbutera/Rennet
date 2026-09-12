// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeMigrationLoader } from "./Migrations.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

/**
 * Plays the OTHER connection in the fork-column race: it takes SQLite's
 * write lock immediately (`BEGIN IMMEDIATE`), signals that it holds it, then
 * only after a delay adds the two columns `applyForkColumnAdditions` also
 * adds and commits. This is what used to make a second, unguarded connection
 * fail: it holds the lock across its own check-then-add, exactly like the
 * fix now does, so whichever connection loses the race has to wait for it
 * and then re-observe the columns as already present rather than missing.
 */
const raceWinnerSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("ALTER TABLE projection_threads ADD COLUMN instructions TEXT");
  db.exec("ALTER TABLE projection_threads ADD COLUMN mcp_servers_json TEXT");
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnRaceWinner = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const winner = NodeChildProcess.spawn(
          process.execPath,
          ["-e", raceWinnerSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        winner.stdout.once("data", () => resolve());
        winner.on("error", reject);
        winner.on("exit", () =>
          reject(new Error("race winner exited before acquiring the write lock")),
        );
      }),
  );

const readProjectionThreadColumnsEffect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
});

/**
 * The real entry point every server (and CLI) process builds: it sets
 * `busy_timeout`/WAL on the fresh connection and runs `runMigrations()` as
 * part of building the layer. Using it here — rather than a bare
 * `NodeSqliteClient.layer` — is what makes the race real: a connection with
 * no busy timeout fails `BEGIN IMMEDIATE` with `SQLITE_BUSY` immediately
 * instead of waiting on the other connection's held lock, which would misfire
 * this test on the wrong error before ever reaching the bug it is for.
 */
const withRealPersistence = (dbPath: string) =>
  Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)));

it.effect(
  "does not fail with a duplicate column when another connection already added the fork columns first",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migrations-race-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");

    return Effect.gen(function* () {
      // Migrate through migration 44 (which creates `projection_threads`)
      // WITHOUT the fork columns. `runMigrations` always adds them in the
      // same call, so reaching "table exists, fork columns missing" — the
      // starting point this race needs — means driving the raw migrator
      // directly instead of the public entry point, exactly once, up front.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 5000`;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* Migrator.make({})({ loader: makeMigrationLoader(44) });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

      // The other connection wins the race: it takes the write lock first
      // and holds it while it adds the columns, so this test's own attempt
      // (below) has to wait behind it rather than interleave with it.
      yield* spawnRaceWinner(dbPath, 300);

      // A brand-new connection now runs the exact code path under test, via
      // the real entry point. Before the fix: its PRAGMA read isn't blocked
      // by the winner's held write lock (a WAL reader doesn't wait on a
      // writer), so it still observes the columns as missing; its own ALTER
      // then blocks on that held lock, unblocks once the winner commits, and
      // fails with `duplicate column name: instructions` against the column
      // the winner already added. After the fix: its own `BEGIN IMMEDIATE`
      // blocks on the same lock (its connection's own `busy_timeout` makes it
      // wait rather than fail immediately), and once it acquires the lock it
      // re-reads the columns fresh and finds them already there.
      const columns = yield* readProjectionThreadColumnsEffect.pipe(withRealPersistence(dbPath));
      assert.isTrue(columns.some((column) => column.name === "instructions"));
      assert.isTrue(columns.some((column) => column.name === "mcp_servers_json"));
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("adds the fork columns to a freshly migrated database", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migrations-fresh-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const columns = yield* readProjectionThreadColumnsEffect.pipe(withRealPersistence(dbPath));
    assert.isTrue(columns.some((column) => column.name === "instructions"));
    assert.isTrue(columns.some((column) => column.name === "mcp_servers_json"));

    // Idempotent on a database that already has them: opening the real
    // persistence layer a second time (which runs `runMigrations()` again)
    // is a no-op rather than a duplicate-column failure.
    const columnsAfterSecondOpen = yield* readProjectionThreadColumnsEffect.pipe(
      withRealPersistence(dbPath),
    );
    assert.equal(
      columnsAfterSecondOpen.filter((column) => column.name === "instructions").length,
      1,
    );
    assert.equal(
      columnsAfterSecondOpen.filter((column) => column.name === "mcp_servers_json").length,
      1,
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
