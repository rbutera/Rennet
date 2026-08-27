import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_WIRE_SCHEMA } from "@rennet/protocol";
import type { Op } from "@wboard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBoardStore } from "./file-board-store";

const SCHEMA = BOARD_WIRE_SCHEMA;

function createOp(id: string, data: Record<string, unknown> = {}): Op {
  return {
    op: "create",
    op_id: `op-${id}`,
    element: { id, kind: "prose", data },
  };
}

describe("FileBoardStore", () => {
  let root: string;
  let store: FileBoardStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-board-store-"));
    store = new FileBoardStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("createBoard/getSchema round-trip; unknown board yields undefined", async () => {
    await store.createBoard("b1", SCHEMA);
    expect(await store.getSchema("b1")).toEqual(SCHEMA);
    expect(await store.getSchema("missing")).toBeUndefined();
  });

  it("rejects a duplicate createBoard", async () => {
    await store.createBoard("b1", SCHEMA);
    await expect(store.createBoard("b1", SCHEMA)).rejects.toThrow("board already exists: b1");
  });

  it("append assigns contiguous seqs from 1 and returns the assigned events", async () => {
    await store.createBoard("b1", SCHEMA);
    const first = await store.append("b1", [
      { actor: "lens", op: createOp("e1") },
      { actor: "lens", op: createOp("e2") },
    ]);
    expect(first.map((event) => event.seq)).toEqual([1, 2]);
    const second = await store.append("b1", [{ actor: "human", op: createOp("e3") }]);
    expect(second.map((event) => event.seq)).toEqual([3]);
    expect(second[0]?.actor).toBe("human");
  });

  it("rejects append to an unknown board", async () => {
    await expect(store.append("missing", [{ actor: "a", op: createOp("e1") }])).rejects.toThrow(
      "unknown board: missing",
    );
  });

  it("getEvents filters by afterSeq; unknown board yields empty", async () => {
    await store.createBoard("b1", SCHEMA);
    await store.append("b1", [
      { actor: "a", op: createOp("e1") },
      { actor: "a", op: createOp("e2") },
      { actor: "a", op: createOp("e3") },
    ]);
    expect((await store.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((await store.getEvents("b1", 2)).map((event) => event.seq)).toEqual([3]);
    expect(await store.getEvents("b1", 3)).toEqual([]);
    expect(await store.getEvents("missing", 0)).toEqual([]);
  });

  it("does not alias caller memory on write or read", async () => {
    await store.createBoard("b1", SCHEMA);
    const op = createOp("e1", { text: "original" });
    const entry = { actor: "a", op };
    const appended = await store.append("b1", [entry]);

    // Mutating what was passed in after the call reaches nothing.
    if (op.op !== "create") throw new Error("fixture is a create op");
    op.element.data.text = "mutated-input";
    // Mutating what was read back reaches nothing.
    const readBack = appended[0]?.op;
    if (readBack?.op !== "create") throw new Error("appended op is a create op");
    readBack.element.data.text = "mutated-output";

    const events = await store.getEvents("b1", 0);
    const stored = events[0]?.op;
    if (stored?.op !== "create") throw new Error("stored op is a create op");
    expect(stored.element.data.text).toBe("original");
  });

  it("survives restart: a fresh store on the same directory serves the identical log", async () => {
    await store.createBoard("b1", SCHEMA);
    await store.append("b1", [
      { actor: "a", op: createOp("e1") },
      { actor: "a", op: createOp("e2") },
    ]);
    const before = await store.getEvents("b1", 0);

    const reopened = new FileBoardStore(root);
    expect(await reopened.getSchema("b1")).toEqual(SCHEMA);
    expect(await reopened.getEvents("b1", 0)).toEqual(before);

    // And the reopened store continues the seq line, not restarts it.
    const next = await reopened.append("b1", [{ actor: "a", op: createOp("e3") }]);
    expect(next[0]?.seq).toBe(3);
  });

  describe("crash recovery and corruption", () => {
    const logPath = () => join(root, Buffer.from("b1", "utf8").toString("base64url"), "log.jsonl");
    const { appendFile, writeFile, readFile } = fsPromises;

    it("drops a torn final line and continues seqs after recovery", async () => {
      await store.createBoard("b1", SCHEMA);
      await store.append("b1", [{ actor: "a", op: createOp("e1") }]);
      await appendFile(logPath(), '{"end":3,"event":{"seq":2,"acto'); // crash mid-write

      const reopened = new FileBoardStore(root);
      expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1]);
      const next = await reopened.append("b1", [{ actor: "a", op: createOp("e2") }]);
      expect(next[0]?.seq).toBe(2);
      // The healed log parses cleanly end to end.
      expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1, 2]);
    });

    it("drops a complete-prefix of an uncommitted batch", async () => {
      await store.createBoard("b1", SCHEMA);
      await store.append("b1", [{ actor: "a", op: createOp("e1") }]);
      // A 3-event batch (end seq 4) whose last event never landed.
      const partial = [2, 3]
        .map((seq) =>
          JSON.stringify({ end: 4, event: { seq, actor: "a", op: createOp(`p${seq}`) } }),
        )
        .join("\n");
      await appendFile(logPath(), `${partial}\n`);

      const reopened = new FileBoardStore(root);
      expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1]);
      const next = await reopened.append("b1", [{ actor: "a", op: createOp("e2") }]);
      expect(next[0]?.seq).toBe(2);
    });

    it("survives a crash interrupted mid-heal: stale temp file, log intact", async () => {
      await store.createBoard("b1", SCHEMA);
      await store.append("b1", [{ actor: "a", op: createOp("e1") }]);
      // The state a crash between temp-write and rename leaves behind: the
      // original log still carries its torn tail, and log.jsonl.heal exists.
      await appendFile(logPath(), '{"end":3,"event":{"seq":2,"acto');
      await writeFile(
        join(root, Buffer.from("b1", "utf8").toString("base64url"), "log.jsonl.heal"),
        "half-written heal",
      );

      const reopened = new FileBoardStore(root);
      expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1]);
      // Appending re-runs the heal (overwriting the stale temp) and continues seqs.
      const next = await reopened.append("b1", [{ actor: "a", op: createOp("e2") }]);
      expect(next[0]?.seq).toBe(2);
      expect((await reopened.getEvents("b1", 0)).map((event) => event.seq)).toEqual([1, 2]);
    });

    it("throws on mid-file corruption instead of returning a truncated log", async () => {
      await store.createBoard("b1", SCHEMA);
      await store.append("b1", [{ actor: "a", op: createOp("e1") }]);
      const intact = await readFile(logPath(), "utf8");
      await writeFile(logPath(), `not json\n${intact}`);

      const reopened = new FileBoardStore(root);
      await expect(reopened.getEvents("b1", 0)).rejects.toThrow(/corrupted board log/);
    });

    it("throws on corrupted schema.json instead of reporting an unknown board", async () => {
      await store.createBoard("b1", SCHEMA);
      const schemaPath = join(root, Buffer.from("b1", "utf8").toString("base64url"), "schema.json");
      await writeFile(schemaPath, "{ definitely not json");

      const reopened = new FileBoardStore(root);
      await expect(reopened.getSchema("b1")).rejects.toThrow();
    });
  });

  it("keeps dot-segment and separator-bearing board ids inside the root", async () => {
    // encodeURIComponent left "." and ".." intact — these ids used to escape.
    for (const id of [".", "..", "../escapee", "a/b"]) {
      await store.createBoard(id, SCHEMA);
      expect(await store.getSchema(id)).toEqual(SCHEMA);
    }
    // Everything landed under the root as flat base64url dirs: the parent of
    // the root gained nothing, and the root holds only non-dot entries.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root);
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(await readdir(join(root, ".."))).not.toContain("schema.json");
  });

  it("keeps boards isolated under one root", async () => {
    await store.createBoard("b1", SCHEMA);
    await store.createBoard("b2", SCHEMA);
    await store.append("b1", [{ actor: "a", op: createOp("e1") }]);
    expect(await store.getEvents("b2", 0)).toEqual([]);
    expect((await store.getEvents("b1", 0)).length).toBe(1);
  });
});
