import type { ChangedRegion, LintContext } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { type BoardMcpServer, generationBoards, startBoardMcpServer } from "./board-mcp-server";
import { seatBoardServer } from "./seat-address";

/**
 * Which board a seat thread is addressed onto (2.6). This is the mapping the composition
 * root calls and nothing else, driven against a real board server so an address that is
 * handed back really does resolve to a board.
 */

const lint = (): Omit<LintContext, "lens"> => ({
  regions: [{ path: "src/auth.ts", side: "head", start: 10, end: 14 }] as ChangedRegion[],
  files: new Map([["src/auth.ts", 200]]),
});

let started: BoardMcpServer[] = [];

afterEach(async () => {
  const running = started;
  started = [];
  for (const server of running) await server.close();
});

const boardsFor = async (generationId: string) =>
  generationBoards(generationId, async () => {
    const server = await startBoardMcpServer({ bearer: () => "bearer-under-test" });
    started.push(server);
    return server;
  });

describe("a seat thread is addressed onto its lane's board (2.6)", () => {
  it("gives the Flagged lane's two seats two addresses onto the ONE flagged board", async () => {
    const boards = await boardsFor("gen-1");
    const lane = await boards.openLane({ target: "flagged", lint: lint() });

    const claude = seatBoardServer(boards, "flagged-claude");
    const codex = seatBoardServer(boards, "flagged-codex");
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(claude?.url).not.toBe(codex?.url);
    // Both resolved to the same lane, so both write the one board — which is the thing a
    // seat-name-as-target lookup would get wrong without changing either url's shape.
    expect(lane.seatWriter("flagged-claude")).toBeDefined();
    expect(lane.seatWriter("flagged-codex")).toBeDefined();
    const first = lane.seatWriter("flagged-claude")?.call("add_section", { title: "Correctness" });
    const second = lane.seatWriter("flagged-codex")?.call("add_section", { title: "Risk" });
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(lane.board().elements).toHaveLength(2);
  });

  it("each lens seat is addressed onto its own lens's board", async () => {
    const boards = await boardsFor("gen-1");
    await boards.openLane({ target: "design", lint: lint() });
    await boards.openLane({ target: "sequence", lint: lint() });

    const design = seatBoardServer(boards, "design");
    const sequence = seatBoardServer(boards, "sequence");
    expect(design?.url).not.toBe(sequence?.url);
    // The Design address writes the Design board and no other.
    boards.lane("design")?.seatWriter("design")?.call("add_section", { title: "The spec" });
    expect(boards.lane("design")?.board().elements).toHaveLength(1);
    expect(boards.lane("sequence")?.board().elements).toHaveLength(0);
  });

  it("a seat whose lane is not open is given no address", async () => {
    const boards = await boardsFor("gen-1");
    await boards.openLane({ target: "design", lint: lint() });
    expect(seatBoardServer(boards, "noise")).toBeUndefined();
  });

  it("a generation with no board server gives no seat an address", () => {
    expect(seatBoardServer(undefined, "design")).toBeUndefined();
  });

  it("a seat name this daemon does not know is given no address", async () => {
    const boards = await boardsFor("gen-1");
    await boards.openLane({ target: "design", lint: lint() });
    expect(seatBoardServer(boards, "design-second-opinion")).toBeUndefined();
  });

  it("the same seat asked twice keeps its address, because the session fixed it", async () => {
    const boards = await boardsFor("gen-1");
    await boards.openLane({ target: "design", lint: lint() });
    expect(seatBoardServer(boards, "design")?.url).toBe(seatBoardServer(boards, "design")?.url);
  });
});
