import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_WIRE_SCHEMA } from "@rennet/protocol";
import type { Op } from "@wboard/core";
import { project } from "@wboard/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "./boards-runtime";

const AUTHOR = { kind: "lens-agent", id: "lens:design" };

function proseOp(id: string, markdown: string): Op {
  return {
    op: "create",
    op_id: `op-${id}`,
    element: { id, kind: "prose", data: { author: AUTHOR, markdown } },
  };
}

describe("boards runtime", () => {
  let projectRoot: string;
  let runtime: BoardsRuntime;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "boards-runtime-"));
    runtime = createBoardsRuntime(projectRoot);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("round-trips: createRennetBoard → apply → getEvents → getState", async () => {
    const boardId = await runtime.createRennetBoard();
    expect(await runtime.service.getSchema(boardId)).toEqual(BOARD_WIRE_SCHEMA);

    const ops = [proseOp("p1", "First."), proseOp("p2", "Second.")];
    const applied = await runtime.service.apply(boardId, ops, "lens:design");
    expect(applied).toEqual({ ok: true });

    const { events, cursor } = await runtime.service.getEvents(boardId);
    expect(events.map((e) => e.op.op_id)).toEqual(["op-p1", "op-p2"]);
    expect(cursor).toBe(2);

    const state = await runtime.service.getState(boardId);
    expect(state.get("p1")?.data.markdown).toBe("First.");
    expect(project(events).elements.get("p2")?.data.markdown).toBe("Second.");
  });

  it("rejects a batch with a host-schema-invalid op wholly and appends nothing", async () => {
    const boardId = await runtime.createRennetBoard();
    const bad: Op = {
      op: "create",
      op_id: "op-bad",
      // prose requires markdown — its absence must reject the whole batch.
      element: { id: "bad", kind: "prose", data: { author: AUTHOR } },
    };
    const result = await runtime.service.apply(boardId, [proseOp("ok", "Fine."), bad], "actor");
    expect(result.ok).toBe(false);
    expect((await runtime.service.getEvents(boardId)).events).toEqual([]);
  });

  it("op_id replay appends nothing (#453 idempotency)", async () => {
    const boardId = await runtime.createRennetBoard();
    const ops = [proseOp("p1", "Once.")];
    expect(await runtime.service.apply(boardId, ops, "actor")).toEqual({ ok: true });
    expect(await runtime.service.apply(boardId, ops, "actor")).toEqual({ ok: true });
    expect((await runtime.service.getEvents(boardId)).events).toHaveLength(1);
  });

  it("emits exactly the appended events to onEvents; a replay emits nothing (B4 broadcast hook)", async () => {
    const emitted: { boardId: string; opIds: string[]; seqs: number[] }[] = [];
    const observed = createBoardsRuntime(projectRoot, (boardId, events) =>
      emitted.push({
        boardId,
        opIds: events.map((e) => e.op.op_id),
        seqs: events.map((e) => e.seq),
      }),
    );
    const boardId = await observed.createRennetBoard();
    await observed.service.apply(boardId, [proseOp("p1", "One."), proseOp("p2", "Two.")], "actor");
    expect(emitted).toEqual([{ boardId, opIds: ["op-p1", "op-p2"], seqs: [1, 2] }]);

    // Replay dedups before append — nothing new is emitted.
    await observed.service.apply(boardId, [proseOp("p1", "One.")], "actor");
    expect(emitted).toHaveLength(1);

    // A rejected batch appends nothing and emits nothing.
    const bad: Op = {
      op: "create",
      op_id: "op-bad",
      element: { id: "bad", kind: "prose", data: { author: AUTHOR } },
    };
    await observed.service.apply(boardId, [bad], "actor");
    expect(emitted).toHaveLength(1);
  });

  it("persists under <projectRoot>/.rennet/boards/ and survives a fresh runtime", async () => {
    const boardId = await runtime.createRennetBoard();
    await runtime.service.apply(boardId, [proseOp("p1", "Durable.")], "actor");

    const reborn = createBoardsRuntime(projectRoot);
    const { events } = await reborn.service.getEvents(boardId);
    expect(events.map((e) => e.op.op_id)).toEqual(["op-p1"]);
  });
});
