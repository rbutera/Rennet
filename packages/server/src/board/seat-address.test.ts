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
  it("addresses only the compiler onto the flagged board; the review seats are lane-less", async () => {
    const boards = await boardsFor("gen-1");
    const lane = await boards.openLane({ target: "flagged", lint: lint() });

    // The compiler is the sole writer of the flagged board (move two): it reads the two
    // review legs' findings files and compiles the whole board through the tool surface.
    const compile = seatBoardServer(boards, "flagged-compile");
    expect(compile).toBeDefined();

    // The two review seats are lane-less: no target in `SEAT_BOARD_TARGET`, so no address and
    // no board tools. They review with the harness's own file tools and land a findings file.
    expect(seatBoardServer(boards, "flagged-claude")).toBeUndefined();
    expect(seatBoardServer(boards, "flagged-codex")).toBeUndefined();

    // Only the compiler has a writer onto the lane, and it writes the one board.
    expect(lane.seatWriter("flagged-claude")).toBeUndefined();
    expect(lane.seatWriter("flagged-codex")).toBeUndefined();
    const written = lane.seatWriter("flagged-compile")?.call("add_section", { title: "Findings" });
    expect(written?.ok).toBe(true);
    expect(lane.board().elements).toHaveLength(1);
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
