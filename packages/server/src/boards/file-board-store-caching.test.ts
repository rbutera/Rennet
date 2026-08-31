import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_WIRE_SCHEMA } from "@rennet/protocol";
import type { Op } from "@wboard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getEvents(afterSeq)` used to re-read and re-parse the WHOLE log per call and then
 * filter, so `afterSeq` bought nothing, and `append` re-read `schema.json` per batch
 * (perf audit §3 H1 / §4 H4). These tests COUNT the file reads: the value the slow
 * version returned was already correct, so only the count tells the two apart.
 *
 * `node:fs/promises`'s namespace is not spy-able (ESM, non-configurable), so the module
 * is mocked with pass-through counters and the store imported after it.
 */
const counts = vi.hoisted(() => ({ log: 0, schema: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (String(path).endsWith("log.jsonl")) counts.log += 1;
      if (String(path).endsWith("schema.json")) counts.schema += 1;
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

const { FileBoardStore } = await import("./file-board-store");

const SCHEMA = BOARD_WIRE_SCHEMA;

function createOp(id: string, data: Record<string, unknown> = {}): Op {
  return { op: "create", op_id: `op-${id}`, element: { id, kind: "prose", data } };
}

describe("FileBoardStore read caching", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-board-store-cache-"));
    counts.log = 0;
    counts.schema = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("never reads the log or the schema again after createBoard", async () => {
    const store = new FileBoardStore(root);
    await store.createBoard("b1", SCHEMA);

    // createBoard WROTE both, so the store already knows them: 30 appends and 30 reads
    // charge nothing. Previously this was 60 whole-log parses plus 30 schema reads.
    for (let i = 0; i < 30; i++) {
      await store.append("b1", [{ actor: "lens", op: createOp(`e${i}`) }]);
      await store.getEvents("b1", i);
    }
    expect([counts.log, counts.schema]).toEqual([0, 0]);
    expect((await store.getEvents("b1", 0)).map((event) => event.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });

  it("reads the log once on a fresh instance, then serves afterSeq from memory", async () => {
    const seed = new FileBoardStore(root);
    await seed.createBoard("b1", SCHEMA);
    await seed.append(
      "b1",
      Array.from({ length: 5 }, (_, i) => ({ actor: "a", op: createOp(`e${i}`) })),
    );

    const reopened = new FileBoardStore(root);
    counts.log = 0;
    counts.schema = 0;
    expect((await reopened.getEvents("b1", 3)).map((event) => event.seq)).toEqual([4, 5]);
    expect(counts.log).toBe(1); // cold start: the log IS re-read from disk

    expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await reopened.getEvents("b1", 5)).map((event) => event.seq)).toEqual([]);
    expect(counts.log).toBe(1); // …and only once

    // The schema is likewise read once, not per append.
    expect(await reopened.getSchema("b1")).toEqual(SCHEMA);
    await reopened.append("b1", [{ actor: "a", op: createOp("e5") }]);
    await reopened.append("b1", [{ actor: "a", op: createOp("e6") }]);
    expect(counts.schema).toBe(1);
  });

  it("still hands the caller its own copy of a cached event", async () => {
    // The log now lives in memory, so `getEvents` must clone the slice it returns — the
    // ownership rule the store documents is no longer free by way of re-parsing.
    const store = new FileBoardStore(root);
    await store.createBoard("b1", SCHEMA);
    await store.append("b1", [{ actor: "a", op: createOp("e1", { text: "original" }) }]);

    const first = (await store.getEvents("b1", 0))[0]?.op;
    if (first?.op !== "create") throw new Error("stored op is a create op");
    first.element.data.text = "mutated";

    const second = (await store.getEvents("b1", 0))[0]?.op;
    if (second?.op !== "create") throw new Error("stored op is a create op");
    expect(second.element.data.text).toBe("original");
  });

  it("heals the FILE after a torn tail, not just the log it holds in memory", async () => {
    // The existing crash-recovery tests read back through `getEvents` on the same
    // instance that healed — which now answers from memory and would pass whether or
    // not the heal ever reached disk. A THIRD instance is what actually reads the file.
    const { appendFile } = await import("node:fs/promises");
    const seed = new FileBoardStore(root);
    await seed.createBoard("b1", SCHEMA);
    await seed.append("b1", [{ actor: "a", op: createOp("e1") }]);
    const logPath = join(root, Buffer.from("b1", "utf8").toString("base64url"), "log.jsonl");
    await appendFile(logPath, '{"end":3,"event":{"seq":2,"acto'); // crash mid-write

    const reopened = new FileBoardStore(root);
    expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1]);
    await reopened.append("b1", [{ actor: "a", op: createOp("e2") }]);

    // If the heal had not landed, this log would read `ok / torn / ok` — mid-file
    // corruption, which throws rather than quietly truncating.
    const third = new FileBoardStore(root);
    expect((await third.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1, 2]);
  });
});
