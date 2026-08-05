import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

function openStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      version INTEGER NOT NULL,
      private INTEGER NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      result TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}

function append(db, type, payload, { version = 3, privateEvent = false } = {}) {
  db.prepare("INSERT INTO events (type, version, private, payload) VALUES (?, ?, ?, ?)")
    .run(type, version, privateEvent ? 1 : 0, JSON.stringify(payload));
}

function loadEvents(db) {
  return db.prepare("SELECT seq, type, version, private, payload FROM events ORDER BY seq")
    .all()
    .map((row) => ({ ...row, private: Boolean(row.private), payload: JSON.parse(row.payload) }));
}

function upcast(event) {
  let current = structuredClone(event);
  while (current.version < 3) {
    if (current.type === "review.started" && current.version === 1) {
      current = {
        ...current,
        version: 2,
        payload: { reviewId: current.payload.id },
      };
      continue;
    }
    if (current.type === "review.started" && current.version === 2) {
      current = {
        ...current,
        version: 3,
        payload: { ...current.payload, source: "legacy" },
      };
      continue;
    }
    throw new Error(`No upcaster for ${current.type}@${current.version}`);
  }
  return current;
}

function fold(state, rawEvent) {
  const event = upcast(rawEvent);
  if (event.private) return state;

  switch (event.type) {
    case "review.started":
      return { ...state, reviewId: event.payload.reviewId, source: event.payload.source };
    case "finding.added":
      return { ...state, findingIds: [...state.findingIds, event.payload.findingId] };
    case "publish.prepared":
      return { ...state, publish: { marker: event.payload.marker, outcome: "prepared" } };
    case "publish.outcome-unknown":
      return { ...state, publish: { marker: event.payload.marker, outcome: "unknown" } };
    case "publish.reconciled":
      return {
        ...state,
        publish: {
          marker: event.payload.marker,
          outcome: "published",
          externalId: event.payload.externalId,
        },
      };
    default:
      throw new Error(`Incompatible event type: ${event.type}`);
  }
}

function project(events) {
  return events.reduce(fold, { reviewId: null, source: null, findingIds: [], publish: null });
}

function outboundBytes(events) {
  const state = project(events);
  return JSON.stringify({
    reviewId: state.reviewId,
    source: state.source,
    findingIds: state.findingIds,
    publish: state.publish,
  });
}

function executeLocalCommand(db, commandId, action) {
  const existing = db.prepare("SELECT result FROM commands WHERE command_id = ?").get(commandId);
  if (existing) return JSON.parse(existing.result);

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.prepare("INSERT INTO commands (command_id, result) VALUES (?, ?)")
      .run(commandId, JSON.stringify(result));
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

class FakeForge {
  reviewsByMarker = new Map();
  submissions = 0;

  find(marker) {
    return this.reviewsByMarker.get(marker) ?? null;
  }

  submit(marker, failAt) {
    if (failAt === "before-acceptance") throw new Error("transport failed before acceptance");
    this.submissions += 1;
    const review = { id: `review-${this.submissions}`, marker };
    this.reviewsByMarker.set(marker, review);
    if (failAt === "after-acceptance") throw new Error("response lost after acceptance");
    return review;
  }
}

function attemptPublish(db, forge, { commandId, marker, failAt = null }) {
  const completed = db.prepare("SELECT result FROM commands WHERE command_id = ?").get(commandId);
  if (completed) return JSON.parse(completed.result);

  const existing = forge.find(marker);
  if (existing) {
    append(db, "publish.reconciled", { marker, externalId: existing.id });
    const result = { outcome: "published", externalId: existing.id, reconciled: true };
    db.prepare("INSERT INTO commands (command_id, result) VALUES (?, ?)")
      .run(commandId, JSON.stringify(result));
    return result;
  }

  if (!loadEvents(db).some((event) => event.type === "publish.prepared" && event.payload.marker === marker)) {
    append(db, "publish.prepared", { marker });
  }

  try {
    const review = forge.submit(marker, failAt);
    append(db, "publish.reconciled", { marker, externalId: review.id });
    const result = { outcome: "published", externalId: review.id, reconciled: false };
    db.prepare("INSERT INTO commands (command_id, result) VALUES (?, ?)")
      .run(commandId, JSON.stringify(result));
    return result;
  } catch {
    append(db, "publish.outcome-unknown", { marker });
    return { outcome: "unknown" };
  }
}

test("replay from zero equals incremental folding", () => {
  const db = openStore();
  append(db, "review.started", { reviewId: "r1", source: "working-tree" });
  append(db, "finding.added", { findingId: "f1" });
  append(db, "finding.added", { findingId: "f2" });

  const events = loadEvents(db);
  const incremental = events.reduce(fold, { reviewId: null, source: null, findingIds: [], publish: null });
  assert.deepEqual(project(events), incremental);
});

test("golden v1 stream chains through v2 to v3", () => {
  const event = upcast({ type: "review.started", version: 1, private: false, payload: { id: "legacy" } });
  assert.deepEqual(event.payload, { reviewId: "legacy", source: "legacy" });
  assert.equal(event.version, 3);
});

test("private event variation cannot change outbound bytes", () => {
  const publicEvents = [
    { type: "review.started", version: 3, private: false, payload: { reviewId: "r1", source: "pull-request" } },
    { type: "finding.added", version: 3, private: false, payload: { findingId: "f1" } },
  ];
  const privateEvents = [
    { type: "ui.viewport-recorded", version: 3, private: true, payload: { line: 40 } },
    { type: "review.pace-recorded", version: 3, private: true, payload: { milliseconds: 9000 } },
  ];

  const expected = outboundBytes(publicEvents);
  assert.equal(outboundBytes([privateEvents[0], ...publicEvents, privateEvents[1]]), expected);
  assert.equal(outboundBytes([...publicEvents, ...privateEvents.reverse()]), expected);
  assert.equal(outboundBytes(publicEvents), expected);
});

test("duplicate local command returns its recorded result without another event", () => {
  const db = openStore();
  let executions = 0;
  const action = () => {
    executions += 1;
    append(db, "review.started", { reviewId: "r1", source: "working-tree" });
    return { reviewId: "r1" };
  };

  assert.deepEqual(executeLocalCommand(db, "cmd-1", action), { reviewId: "r1" });
  assert.deepEqual(executeLocalCommand(db, "cmd-1", action), { reviewId: "r1" });
  assert.equal(executions, 1);
  assert.equal(loadEvents(db).length, 1);
});

test("failure before remote acceptance reconciles to one review", () => {
  const db = openStore();
  const forge = new FakeForge();
  assert.deepEqual(
    attemptPublish(db, forge, { commandId: "pub-1", marker: "marker-1", failAt: "before-acceptance" }),
    { outcome: "unknown" },
  );
  assert.equal(forge.reviewsByMarker.size, 0);
  const retry = attemptPublish(db, forge, { commandId: "pub-1", marker: "marker-1" });
  assert.equal(retry.outcome, "published");
  assert.equal(forge.reviewsByMarker.size, 1);
});

test("failure after remote acceptance queries before retry and never duplicates", () => {
  const db = openStore();
  const forge = new FakeForge();
  assert.deepEqual(
    attemptPublish(db, forge, { commandId: "pub-2", marker: "marker-2", failAt: "after-acceptance" }),
    { outcome: "unknown" },
  );
  assert.equal(forge.reviewsByMarker.size, 1);
  const retry = attemptPublish(db, forge, { commandId: "pub-2", marker: "marker-2" });
  assert.deepEqual(retry, { outcome: "published", externalId: "review-1", reconciled: true });
  assert.equal(forge.reviewsByMarker.size, 1);
  assert.equal(forge.submissions, 1);
});

test("unknown event types fail closed", () => {
  assert.throws(
    () => project([{ type: "future.event", version: 3, private: false, payload: {} }]),
    /Incompatible event type/,
  );
});
