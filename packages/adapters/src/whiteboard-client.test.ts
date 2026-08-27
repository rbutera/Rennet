import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { WireSchema } from "@wboard/core";
import { BoardService, InMemoryBoardStore } from "@wboard/server";
import { describe, expect, it } from "vitest";
import { type DraftOp, WhiteboardClient } from "./whiteboard-client";

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

describe("writer invariant (task 3.2) — WhiteboardClient is the only board-op writer", () => {
  it("no other non-test source calls .apply( anywhere in the workspace", () => {
    // Executable form of the recorded grep proof: scan packages/ and apps/
    // sources for `.apply(` call sites. The allowlist names the only
    // sanctioned writer; Function.prototype.apply or any new BoardService
    // writer alike must show up here and be consciously allowlisted (a board
    // writer never should be). Lightweight regex by design, not an AST pass.
    //
    // `sanctionedCallers` names files that call the INJECTED WhiteboardClient's
    // `.apply` — the exact case the client's docstring anticipates ("the B8
    // drafters ... route their ops through WhiteboardClient.apply"). They are
    // callers, not writers: the strengthened invariant below proves each one
    // never imports `BoardService`, so an allowlisted caller can never quietly
    // become a second direct writer.
    const workspaceRoot = join(__dirname, "..", "..", "..");
    const allowed = new Set(["packages/adapters/src/whiteboard-client.ts"]);
    const sanctionedCallers = new Set([
      "packages/server/src/runtime/lens-pipeline.ts",
      // B09 cluster 4: rework one-shot workers land their write through the injected
      // WhiteboardClient (never a second writer); it imports no BoardService.
      "packages/server/src/session/rework-queue.ts",
    ]);
    const offenders: string[] = [];
    const directWriters: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".nx")
            continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        if (entry.name.includes(".test.") || entry.name.endsWith(".d.ts")) continue;
        const source = readFileSync(path, "utf8");
        if (!/\.apply\(/.test(source)) continue;
        const rel = relative(workspaceRoot, path).split(sep).join("/");
        if (allowed.has(rel)) continue;
        if (sanctionedCallers.has(rel)) {
          // A sanctioned caller must route through the client, never the service.
          if (/BoardService/.test(source)) directWriters.push(rel);
          continue;
        }
        offenders.push(rel);
      }
    };
    walk(join(workspaceRoot, "packages"));
    walk(join(workspaceRoot, "apps"));
    expect(offenders).toEqual([]);
    // No sanctioned caller has smuggled in a direct BoardService writer.
    expect(directWriters).toEqual([]);
  });
});

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
