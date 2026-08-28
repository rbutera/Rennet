import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhiteboardClient } from "@rennet/adapters";
import type { DraftBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createBoardsRuntime } from "../boards/boards-runtime";
import { projectLensBoard } from "./lens-board-read";
import { draftToOps } from "./lens-pipeline";

// The lens-board read, proven over the REAL substrate: a board is written exactly as
// `runLensBoard` writes it (`draftToOps` through the whiteboard client onto a minted
// board in a `.rennet/boards/` store), then read back through the projection the
// `board.read` handler serves. The control is round-trip: change what the projection
// derives and the assertions below stop matching what was written.

const author = { kind: "lens-agent", id: "test" } as const;

/** A two-section board with a nested section, a citation, and per-kind children. */
const board: DraftBoard = {
  skippedHunks: [{ hunk: "h9", reason: "sequence's lane" }],
  elements: [
    {
      id: "change",
      kind: "section",
      data: {
        author,
        title: "The Change",
        gist: "Two decisions, one requirement.",
        children: ["d1", "r1", "nested"],
        delta: "reworked",
      },
    },
    {
      id: "nested",
      kind: "section",
      data: { author, title: "Nested", children: ["p1"] },
    },
    { id: "p1", kind: "prose", data: { author, markdown: "nested prose" } },
    {
      id: "d1",
      kind: "decision",
      data: { author, statement: "s", why: "w", evidence: ["c1"], alternatives: [] },
    },
    { id: "r1", kind: "requirement", data: { author, shall: "SHALL", coverage: "met", trace: [] } },
    {
      id: "c1",
      kind: "code_ref",
      data: {
        author,
        patchset_id: "ps-1",
        path: "packages/server/src/a.ts",
        side: "head",
        start_line: 1,
        end_line: 2,
      },
    },
  ],
} as DraftBoard;

/** Write `board` to a fresh board in a temp store and project it back. */
async function roundTrip() {
  const runtime = createBoardsRuntime(mkdtempSync(join(tmpdir(), "rennet-board-read-")));
  const boardId = await runtime.createRennetBoard();
  const result = await new WhiteboardClient(runtime.service).apply(
    boardId,
    draftToOps(board),
    "lens:design",
  );
  expect(result.response.ok).toBe(true);
  const state = await runtime.service.getState(boardId);
  return projectLensBoard([...state.values()], {
    lens: "design",
    generation: "gen-1",
    boardId,
    skippedHunks: [{ hunk: "h9", reason: "sequence's lane" }],
  });
}

describe("projectLensBoard — the persisted board, read back", () => {
  it("rebuilds the board's identity, elements, and coverage from what was written", async () => {
    const read = await roundTrip();
    expect(read.lens).toBe("design");
    expect(read.generation).toBe("gen-1");
    expect(read.boardId).toBeTruthy();
    // Every written element survives the round trip — nothing dropped, nothing added.
    expect(read.elements.map((el) => el.id).sort()).toEqual([
      "c1",
      "change",
      "d1",
      "nested",
      "p1",
      "r1",
    ]);
    // Board-level coverage cannot ride the element log, so it comes from the meta record.
    expect(read.skippedHunks).toEqual([{ hunk: "h9", reason: "sequence's lane" }]);
  });

  it("folds only TOP-LEVEL sections, with counts tallied from their own children", async () => {
    const read = await roundTrip();
    // `nested` is a child of `change`, so it is part of that section's tree, not a
    // second fold line — a projection that listed it would invent a top-level section.
    expect(read.sections.map((s) => s.ref)).toEqual(["change"]);
    const [change] = read.sections;
    expect(change?.counts).toEqual({ decision: 1, requirement: 1, section: 1 });
    expect(change?.gist).toBe("Two decisions, one requirement.");
    expect(change?.delta).toBe("reworked");
  });

  it("falls back to the section's own title when the board carries no gist", () => {
    // Never a summary this projection wrote — the section's own words or nothing.
    const read = projectLensBoard(
      [{ id: "s", kind: "section", data: { author, title: "Untitled Work", children: [] } }],
      { lens: "noise", generation: "g", boardId: "b", skippedHunks: [] },
    );
    expect(read.sections[0]?.gist).toBe("Untitled Work");
    expect(read.sections[0]?.counts).toEqual({});
  });
});
