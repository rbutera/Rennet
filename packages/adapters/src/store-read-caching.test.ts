import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindTarget, mintSession } from "@rennet/core";
import type { AskEventBody, SessionTranscriptRow } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The JSON-store family's READ cost (perf audit §3 H1, §4 H4/H5): every store used to
 * re-read and re-validate its whole file per operation. These tests COUNT the disk reads
 * rather than asserting a shape, because "serves the same value" is exactly what the slow
 * version already did — only the count distinguishes a memo from a re-read.
 *
 * What is NOT covered here, and is the other half of the audit item: the WRITE side. Every
 * mutation still serializes and rewrites the file whole, so a write is still O(n) bytes and
 * a session's writes are still O(n²) — deliberate scope, since an append-only on-disk format
 * is a persistence-format change rather than a caching one. A green run means reads stopped
 * re-parsing; it does NOT mean the quadratic is gone.
 *
 * `node:fs`'s namespace is not spy-able (ESM, non-configurable), so the module is mocked
 * with pass-through counters. The stores are imported AFTER the mock so they bind to it.
 */
const counts = vi.hoisted(() => ({ readFileSync: 0, readdirSync: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      counts.readFileSync += 1;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      counts.readdirSync += 1;
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

const { AskLogStore } = await import("./ask-log-store");
const { TranscriptStore } = await import("./transcript-store");
const { SessionStore } = await import("./session-store");

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Reads charged while `work` ran. The counter is global to the module, so every
 *  assertion measures a WINDOW rather than a total. */
function readsDuring(work: () => void): number {
  const before = counts.readFileSync;
  work();
  return counts.readFileSync - before;
}

beforeEach(() => {
  counts.readFileSync = 0;
  counts.readdirSync = 0;
});

const stage = (id: string): AskEventBody => ({
  kind: "stage",
  ask: { id, anchor: `a:${id}`, type: "comment", body: `b:${id}` },
});

describe("AskLogStore read caching", () => {
  it("charges one read for the cold log and none for any later write or projection", () => {
    const dir = tmpDir("ask-cache-");
    const store = new AskLogStore(dir);

    // Cold: the log is absent, and the ENOENT probe is the one read.
    expect(readsDuring(() => store.append("s1", stage("a0")))).toBe(1);

    // Warm: 20 more writes, each followed by the three `readProjection` calls the ask
    // dispatch makes (prior, broadcast, response). Zero further reads — the count, not
    // the values, is what separates this from the version that re-parsed 60 times.
    const warm = readsDuring(() => {
      for (let i = 1; i <= 20; i++) {
        store.readProjection("s1");
        store.append("s1", stage(`a${i}`));
        store.readProjection("s1");
        store.readProjection("s1");
      }
    });
    expect(warm).toBe(0);

    // …and the memo is the same answer the fold gives, incrementally extended.
    const projection = store.readProjection("s1");
    expect(Object.keys(projection.stagedAsks).sort()).toEqual(
      Array.from({ length: 21 }, (_, i) => `a${i}`).sort(),
    );
    expect(store.read("s1").map((event) => event.seq)).toEqual(
      Array.from({ length: 21 }, (_, i) => i),
    );
  });

  it("serves a fresh instance from disk (cold start), not from another instance's memo", () => {
    const dir = tmpDir("ask-cold-");
    new AskLogStore(dir).append("s1", stage("a1"));

    const reopened = new AskLogStore(dir);
    let projection!: ReturnType<typeof reopened.readProjection>;
    expect(readsDuring(() => (projection = reopened.readProjection("s1")))).toBe(1);
    expect(Object.keys(projection.stagedAsks)).toEqual(["a1"]);
  });

  it("sees a write made through a second store instance", () => {
    // The E2E suites do exactly this: `board-lenses.spec.ts` polls `readProjection` on its
    // own store while the daemon appends. A memo that ignored the file would poll forever.
    const dir = tmpDir("ask-foreign-");
    const mine = new AskLogStore(dir);
    const theirs = new AskLogStore(dir);
    mine.append("s1", stage("a1"));
    expect(Object.keys(mine.readProjection("s1").stagedAsks)).toEqual(["a1"]);

    theirs.append("s1", stage("a2"));
    expect(Object.keys(mine.readProjection("s1").stagedAsks).sort()).toEqual(["a1", "a2"]);
  });

  it("re-validates a corrupt file rather than answering from a stale memo", () => {
    const dir = tmpDir("ask-corrupt-");
    const store = new AskLogStore(dir);
    store.append("s1", stage("a1"));
    expect(store.read("s1")).toHaveLength(1);

    writeFileSync(join(dir, "s1.json"), "{ not json");
    expect(() => store.read("s1")).toThrow(/unreadable\/corrupt/);
  });
});

const turn = (id: string): SessionTranscriptRow => ({
  kind: "turn",
  id,
  speaker: "orchestrator",
  status: "complete",
  paragraphs: ["hello"],
});

describe("TranscriptStore read caching", () => {
  it("charges one read for the cold log and none for later appends", () => {
    const dir = tmpDir("transcript-cache-");
    const store = new TranscriptStore(dir);

    expect(readsDuring(() => store.append("s1", [turn("r0")]))).toBe(1);
    const warm = readsDuring(() => {
      for (let i = 1; i <= 20; i++) {
        store.append("s1", [turn(`r${i}`)]);
        store.appendUnique("s1", [turn(`u${i}`)]);
        store.read("s1");
      }
    });
    expect(warm).toBe(0);
    expect(store.read("s1")).toHaveLength(41);
  });

  it("keeps appendUnique's dedup honest across a warm id set", () => {
    const dir = tmpDir("transcript-unique-");
    const store = new TranscriptStore(dir);
    store.appendUnique("s1", [turn("a"), turn("b"), turn("a")]);
    store.appendUnique("s1", [turn("b"), turn("c")]);
    expect(store.read("s1").map((row) => row.id)).toEqual(["a", "b", "c"]);

    // And a fresh instance, whose id set comes from disk, refuses the same replays.
    const reopened = new TranscriptStore(dir);
    reopened.appendUnique("s1", [turn("a"), turn("d")]);
    expect(reopened.read("s1").map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(new TranscriptStore(dir).read("s1").map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("SessionStore read caching", () => {
  it("charges one read per session for the cold list and none for the second", () => {
    const dir = tmpDir("session-cache-");
    const store = new SessionStore(dir);
    for (let i = 0; i < 5; i++) {
      store.save(
        bindTarget(mintSession("p1", { id: () => `s${i}`, now: () => 1000 + i }), {
          branch: `feat/${i}`,
        }),
      );
    }

    // Saving memoized what it wrote, so even the FIRST list is already warm — the sidebar
    // renders right after a mint. The readdir still happens: a session another writer
    // added must still appear.
    const first = readsDuring(() => store.list());
    const second = readsDuring(() => store.list());
    expect([first, second]).toEqual([0, 0]);
    expect(counts.readdirSync).toBe(2);
    expect(store.list().map((session) => session.id)).toEqual(["s4", "s3", "s2", "s1", "s0"]);
  });

  it("charges one read per session on a cold instance, then none", () => {
    const dir = tmpDir("session-cold-");
    const seed = new SessionStore(dir);
    for (let i = 0; i < 5; i++) {
      seed.save(mintSession("p1", { id: () => `s${i}`, now: () => 1000 + i }));
    }

    const reopened = new SessionStore(dir);
    expect(readsDuring(() => reopened.list())).toBe(5);
    expect(readsDuring(() => reopened.list())).toBe(0);
    expect(readsDuring(() => reopened.load("s3"))).toBe(0);
    expect(reopened.load("s3")?.id).toBe("s3");
  });

  it("serves the state a mutator just wrote, without a read", () => {
    const dir = tmpDir("session-write-through-");
    const store = new SessionStore(dir, { now: () => 5000 });
    store.save(mintSession("p1", { id: () => "s1", now: () => 1000 }));

    expect(readsDuring(() => store.rename("s1", "My review"))).toBe(0);
    expect(store.load("s1")?.title).toBe("My review");
    expect(readsDuring(() => store.setPinned("s1", true))).toBe(0);
    expect(store.load("s1")?.pinned).toBe(true);
    expect(store.archive("s1")?.archivedAt).toBe(5000);
    expect(store.load("s1")?.archivedAt).toBe(5000);
    expect(store.restore("s1")?.archivedAt).toBeUndefined();
    expect(store.load("s1")?.archivedAt).toBeUndefined();
  });

  it("sees a write made through a second store instance", () => {
    // `publish-proof-fixture.ts` polls `load` on its own store while the daemon writes.
    const dir = tmpDir("session-foreign-");
    const mine = new SessionStore(dir);
    const theirs = new SessionStore(dir);
    theirs.save(mintSession("p1", { id: () => "s1", now: () => 1000 }));
    expect(mine.load("s1")?.title).toBeUndefined();

    theirs.rename("s1", "renamed elsewhere");
    expect(mine.load("s1")?.title).toBe("renamed elsewhere");
  });
});
