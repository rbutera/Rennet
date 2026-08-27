import type { WireSchema } from "@wboard/core";
import { BoardService, InMemoryBoardStore } from "@wboard/server";
import { describe, expect, it } from "vitest";
import { type DraftOp, WhiteboardClient } from "./whiteboard-client";

/**
 * Writer-invariant proof (task 3.2), recorded at implementation time:
 *
 *   grep -rn "\.apply(" packages/ apps/ --include="*.ts" | grep -v ".test.ts"
 *
 * returned exactly one hit — whiteboard-client.ts's own `service.apply` call —
 * and `op_id` appears only here, in the client, and in the server's board test
 * fixtures. WhiteboardClient is the only writer of board ops in Rennet.
 */

const NOTE_SCHEMA: WireSchema = {
  kinds: [
    {
      id: "note",
      description: "A short note",
      attributes: [{ name: "text", description: "The note body", type: "string", required: true }],
    },
  ],
};

const note = (id: string, text: string, opId?: string): DraftOp => ({
  op: "create",
  ...(opId === undefined ? {} : { op_id: opId }),
  element: { id, kind: "note", data: { text } },
});

const client = () => new WhiteboardClient(new BoardService(new InMemoryBoardStore()));

describe("WhiteboardClient — the five #455 tools", () => {
  it("create → schema round-trips the declared schema", async () => {
    const wb = client();
    const boardId = await wb.create(NOTE_SCHEMA);
    expect(boardId).toBeTruthy();
    expect(await wb.schema(boardId)).toEqual(NOTE_SCHEMA);
  });

  it("apply mints unique op_ids when absent, then describe and events see the writes", async () => {
    const wb = client();
    const boardId = await wb.create(NOTE_SCHEMA);
    const result = await wb.apply(boardId, [note("n1", "first"), note("n2", "second")], "tester");
    expect(result.response).toEqual({ ok: true });
    expect(result.ops.map((op) => op.op_id)).toHaveLength(2);

    const { events, cursor } = await wb.events(boardId);
    expect(events).toHaveLength(2);
    const opIds = events.map((event) => event.op.op_id);
    expect(new Set(opIds).size).toBe(2);
    for (const opId of opIds) {
      expect(opId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(events.map((event) => event.actor)).toEqual(["tester", "tester"]);
    expect(cursor).toBe(2);

    const described = await wb.describe(boardId);
    expect(described.board_id).toBe(boardId);
  });

  it("passes a supplied op_id through untouched, and replaying it appends nothing", async () => {
    const wb = client();
    const boardId = await wb.create(NOTE_SCHEMA);
    await wb.apply(boardId, [note("n1", "first", "stable-op-1")], "tester");

    const first = await wb.events(boardId);
    expect(first.events.map((event) => event.op.op_id)).toEqual(["stable-op-1"]);

    // Replay with the same op_id: idempotent, nothing appended (#453).
    const replay = await wb.apply(boardId, [note("n1", "first", "stable-op-1")], "tester");
    expect(replay.response).toEqual({ ok: true });
    expect((await wb.events(boardId)).events).toHaveLength(1);
  });

  it("returns the enriched batch so an id-less apply can be retried idempotently", async () => {
    const wb = client();
    const boardId = await wb.create(NOTE_SCHEMA);
    const first = await wb.apply(boardId, [note("n1", "first")], "tester");
    expect(first.response).toEqual({ ok: true });

    // Retrying the RETURNED ops (ids minted once, before the retry boundary)
    // dedups; re-sending the id-less draft would mint anew and append again.
    const retry = await wb.apply(boardId, first.ops, "tester");
    expect(retry.response).toEqual({ ok: true });
    expect(retry.ops).toEqual(first.ops);
    expect((await wb.events(boardId)).events).toHaveLength(1);
  });

  it("events honours the cursor", async () => {
    const wb = client();
    const boardId = await wb.create(NOTE_SCHEMA);
    await wb.apply(boardId, [note("n1", "first")], "tester");
    const { cursor } = await wb.events(boardId);
    await wb.apply(boardId, [note("n2", "second")], "tester");

    const since = await wb.events(boardId, cursor);
    expect(since.events).toHaveLength(1);
    expect(since.events[0]?.op.op === "create" && since.events[0].op.element.id).toBe("n2");
  });

  it("surfaces the service's rejection verbatim and appends nothing", async () => {
    const wb = client();
    const boardId = await wb.create(NOTE_SCHEMA);
    const rejected = await wb.apply(
      boardId,
      [note("n1", "valid"), { op: "create", element: { id: "x1", kind: "mystery", data: {} } }],
      "tester",
    );
    expect(rejected.response.ok).toBe(false);
    if (rejected.response.ok === false) {
      expect(rejected.response.code).toBe("unknown-kind");
    }
    expect((await wb.events(boardId)).events).toHaveLength(0);
  });
});
