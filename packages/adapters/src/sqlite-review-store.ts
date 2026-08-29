import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { foldReview, type ReviewEvent, type ReviewStorePort } from "@rennet/core";
import type { Patchset, Review } from "@rennet/protocol";

interface ReceiptRow {
  payload_digest: string;
  result_json: string;
}

interface EventRow {
  type: string;
  version: number;
  payload_json: string;
}

export class SqliteReviewStore implements ReviewStorePort {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  latestReview(repositoryRoot?: string): Review | null {
    const latest = (
      repositoryRoot === undefined
        ? this.database
            .prepare(
              "SELECT review_id FROM events WHERE type = 'ReviewCreated' ORDER BY seq DESC LIMIT 1",
            )
            .get()
        : this.database
            .prepare(
              "SELECT review_id FROM events WHERE type = 'ReviewCreated' AND repository_root = ? ORDER BY seq DESC LIMIT 1",
            )
            .get(repositoryRoot)
    ) as { review_id: string } | undefined;
    if (!latest) return null;
    return this.reviewById(latest.review_id);
  }

  reviewById(reviewId: string): Review | null {
    const rows = this.database
      .prepare("SELECT type, version, payload_json FROM events WHERE review_id = ? ORDER BY seq")
      .all(reviewId) as unknown as EventRow[];
    let review: Review | null = null;
    for (const row of rows) {
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      const event = { ...parsed, type: row.type, version: row.version } as ReviewEvent;
      review = foldReview(review, event);
    }
    return review;
  }

  patchsetById(patchsetId: string): Patchset | null {
    // Read the patchset straight off the event that carried it, rather than folding a
    // whole review: `ReviewCreated` and `PatchsetActivated` are the only two events that
    // introduce one, and a patchset is immutable, so the event payload IS the stored
    // patchset. `ORDER BY seq DESC LIMIT 1` picks a single row when the same patchset was
    // activated twice (a re-capture that folds to the identical id) — same content either
    // way. json_extract is SQLite's own JSON1 (built into node:sqlite), so the match is on
    // the parsed id, never a substring of the payload text.
    const row = this.database
      .prepare(
        `SELECT payload_json FROM events
         WHERE type IN ('ReviewCreated', 'PatchsetActivated')
           AND json_extract(payload_json, '$.patchset.id') = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(patchsetId) as { payload_json: string } | undefined;
    if (!row) return null;
    return (JSON.parse(row.payload_json) as { patchset: Patchset }).patchset;
  }

  receipt(commandId: string, digest: string): Review | null {
    const row = this.database
      .prepare("SELECT payload_digest, result_json FROM commands WHERE command_id = ?")
      .get(commandId) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.payload_digest !== digest) {
      throw new Error(`Command ${commandId} was already used with a different payload`);
    }
    return JSON.parse(row.result_json) as Review;
  }

  commit(commandId: string, digest: string, events: ReviewEvent[], result: Review): Review {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.receipt(commandId, digest);
      if (replay) {
        this.database.exec("ROLLBACK");
        return replay;
      }
      const insertEvent = this.database.prepare(
        "INSERT INTO events (review_id, type, version, private, repository_root, payload_json) VALUES (?, ?, ?, 0, ?, ?)",
      );
      for (const event of events) {
        const root = event.type === "ReviewCreated" ? event.patchset.repository.root : null;
        insertEvent.run(event.reviewId, event.type, event.version, root, JSON.stringify(event));
      }
      this.database
        .prepare("INSERT INTO commands (command_id, payload_digest, result_json) VALUES (?, ?, ?)")
        .run(commandId, digest, JSON.stringify(result));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendRawForTesting(reviewId: string, type: string, version: number, payload: unknown): void {
    const root =
      type === "ReviewCreated"
        ? ((payload as { patchset?: { repository?: { root?: string } } }).patchset?.repository
            ?.root ?? null)
        : null;
    this.database
      .prepare(
        "INSERT INTO events (review_id, type, version, private, repository_root, payload_json) VALUES (?, ?, ?, 0, ?, ?)",
      )
      .run(reviewId, type, version, root, JSON.stringify(payload));
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id TEXT NOT NULL,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        private INTEGER NOT NULL CHECK (private IN (0, 1)),
        repository_root TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_review_seq ON events (review_id, seq);
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '2');
    `);
    // Forward-migrate a schema_version 1 database atomically: add the per-repo
    // key column, backfill it from the ReviewCreated payloads, index it, and
    // advance the version in ONE transaction so a crash mid-migration rolls back
    // cleanly and the next open re-runs the whole thing (no half-applied state
    // that skips the backfill on the next launch).
    //
    // The repository_root INDEX must come AFTER ensureRepositoryRootColumn: on an
    // existing v1 `events` table the CREATE TABLE above is a no-op, so the column
    // is absent until the ALTER runs, and indexing it any earlier throws
    // `no such column: repository_root` in the constructor for every real v1 DB.
    this.database.exec("BEGIN");
    try {
      this.ensureRepositoryRootColumn();
      this.database.exec(
        "CREATE INDEX IF NOT EXISTS events_repository_root ON events (repository_root)",
      );
      const version = this.database
        .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (version?.value === "1") {
        this.database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schema_version'").run();
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const migrated = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (migrated?.value !== "2") throw new Error(`Unsupported database schema ${migrated?.value}`);
  }

  private ensureRepositoryRootColumn(): void {
    const columns = this.database.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    if (columns.some((column) => column.name === "repository_root")) return;
    this.database.exec("ALTER TABLE events ADD COLUMN repository_root TEXT");
    const rows = this.database
      .prepare("SELECT seq, payload_json FROM events WHERE type = 'ReviewCreated'")
      .all() as { seq: number; payload_json: string }[];
    const update = this.database.prepare("UPDATE events SET repository_root = ? WHERE seq = ?");
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as {
        patchset?: { repository?: { root?: string } };
      };
      const root = payload.patchset?.repository?.root ?? null;
      if (root) update.run(root, row.seq);
    }
  }
}
