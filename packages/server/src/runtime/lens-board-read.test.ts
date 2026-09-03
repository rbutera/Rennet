import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhiteboardClient } from "@rennet/adapters";
import { DELTA_MARK_BASIS } from "@rennet/core";
import type { DraftBoard } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createBoardsRuntime } from "../boards/boards-runtime";
import {
  projectLensBoard,
  projectRoundReportBoard,
  readRoundReportBoardForRecord,
} from "./lens-board-read";
import { draftToOps } from "./lens-pipeline";

// The lens-board read, proven over the REAL substrate: a board is written exactly as
// `runLensBoard` writes it (`draftToOps` through the whiteboard client onto a minted
// board in a `.rennet/boards/` store), then read back through the projection the
// `board.read` handler serves. The control is round-trip: change what the projection
// derives and the assertions below stop matching what was written.

const author = { kind: "lens-agent", id: "test" } as const;

/** A two-section board with a nested section, a citation, and per-kind children. */
const board: DraftBoard = {
  document: {
    title: "Design · durable refresh observations",
    introMarkdown: "Read the specification shape beside the implementation evidence.",
    measure: "structured",
  },
  elements: [
    {
      id: "change",
      kind: "section",
      data: {
        author,
        title: "The Change",
        gist: "Two decisions, one requirement.",
        children: ["d1", "r1", "nested", "c1", "c2"],
        delta: "reworked",
        delta_basis: DELTA_MARK_BASIS,
      },
    },
    {
      id: "nested",
      kind: "section",
      data: { author, title: "Nested", children: ["p1"] },
    },
    { id: "p1", kind: "prose", data: { author, markdown: "nested prose" } },
    {
      id: "risks",
      kind: "section",
      data: { author, title: "Risks", gist: "One open finding.", children: ["f1"] },
    },
    {
      id: "f1",
      kind: "finding",
      data: { author, severity: "high", concern: "c", code: [], concurrence: [], status: "open" },
    },
    {
      id: "d1",
      kind: "decision",
      data: { author, statement: "s", why: "w", evidence: ["c1"], alternatives: [] },
    },
    { id: "r1", kind: "requirement", data: { author, shall: "SHALL", trace: [] } },
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
    {
      id: "c2",
      kind: "code_ref",
      data: {
        author,
        patchset_id: "ps-1",
        path: "packages/server/src/a.ts",
        side: "head",
        start_line: 8,
        end_line: 9,
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
    document: board.document,
  });
}

describe("projectLensBoard — the persisted board, read back", () => {
  it("rebuilds the board's identity, document, and elements from what was written", async () => {
    const read = await roundTrip();
    expect(read.lens).toBe("design");
    expect(read.generation).toBe("gen-1");
    expect(read.boardId).toBeTruthy();
    expect(read.document).toEqual(board.document);
    // Every written element survives the round trip — nothing dropped, nothing added.
    expect(read.elements.map((el) => el.id).sort()).toEqual([
      "c1",
      "c2",
      "change",
      "d1",
      "f1",
      "nested",
      "p1",
      "r1",
      "risks",
    ]);
  });

  it("folds only TOP-LEVEL sections, with counts tallied from their own children", async () => {
    const read = await roundTrip();
    // `nested` is a child of `change`, so it is part of that section's tree, not a
    // second fold line — a projection that listed it would invent a top-level section.
    // The remaining two are the board's READING ORDER, which the projection must preserve
    // across the write/read round trip: `change` was authored before `risks`, so it leads.
    expect(read.sections.map((s) => s.ref)).toEqual(["change", "risks"]);
    const [change] = read.sections;
    // Two code refs into one path are one file, not a misleading "2 files" label.
    expect(change?.counts).toEqual({ decisions: 1, requirements: 1, files: 1 });
    expect(change?.gist).toBe("Two decisions, one requirement.");
    expect(change?.delta).toBe("reworked");
    expect(read.sections[1]?.counts).toEqual({ findings: 1 });
    const countKeys = read.sections.flatMap((section) => Object.keys(section.counts));
    expect(countKeys).toEqual(["decisions", "requirements", "files", "findings"]);
    expect(countKeys).not.toContain("decision");
    expect(countKeys).not.toContain("section");
  });

  it("strips marks minted before the citation basis, and says so, rather than serving them as current", () => {
    // A board persisted under the id-keyed marks (session-bound-workspace D5) carries
    // `delta` with no basis. Shown as current, it would badge a section for the wrong
    // reason; the projection shows no mark and names why.
    const legacy = projectLensBoard(
      [
        {
          id: "s",
          kind: "section",
          data: { author, title: "Old", children: [], delta: "reworked" },
        },
      ],
      { lens: "noise", generation: "g", boardId: "b" },
    );
    expect(legacy.sections[0]?.delta).toBeUndefined();
    expect(legacy.elements[0]?.data).not.toHaveProperty("delta");
    expect(legacy.marksStripped).toBe("pre-citation-basis");
    // Control: the same mark stamped with the current basis is served, and nothing is said.
    const current = projectLensBoard(
      [
        {
          id: "s",
          kind: "section",
          data: {
            author,
            title: "Old",
            children: [],
            delta: "reworked",
            delta_basis: DELTA_MARK_BASIS,
          },
        },
      ],
      { lens: "noise", generation: "g", boardId: "b" },
    );
    expect(current.sections[0]?.delta).toBe("reworked");
    expect(current.marksStripped).toBeUndefined();
  });

  it("falls back to the section's own title when the board carries no gist", () => {
    // Never a summary this projection wrote — the section's own words or nothing.
    const read = projectLensBoard(
      [{ id: "s", kind: "section", data: { author, title: "Untitled Work", children: [] } }],
      { lens: "noise", generation: "g", boardId: "b" },
    );
    expect(read.sections[0]?.gist).toBe("Untitled Work");
    expect(read.sections[0]?.counts).toEqual({});
    expect(read.document).toEqual({ title: "Noise", introMarkdown: "", measure: "reading" });
  });

  it("projects a persisted report with report identity and its round outcomes intact", async () => {
    const report: DraftBoard = {
      document: {
        title: "Round 2 changed the retry boundary",
        introMarkdown: "The worker addressed the staged retry request.",
        measure: "reading",
      },
      elements: [
        {
          id: "outcomes",
          kind: "section",
          data: { author, title: "Outcomes", children: ["outcome-1"] },
        },
        {
          id: "outcome-1",
          kind: "round_outcome",
          data: {
            author,
            status: "addressed",
            ask: { ref: "ask-1", text: "Cap the retry loop." },
            note: "The loop now stops at the configured cap.",
          },
        },
      ],
    };
    const runtime = createBoardsRuntime(mkdtempSync(join(tmpdir(), "rennet-report-read-")));
    const boardId = await runtime.createRennetBoard();
    const result = await new WhiteboardClient(runtime.service).apply(
      boardId,
      draftToOps(report),
      "report-seat",
    );
    expect(result.response.ok).toBe(true);

    const state = await runtime.service.getState(boardId);
    const read = projectRoundReportBoard([...state.values()], {
      lens: "report",
      generation: "gen-2",
      boardId,
      document: report.document,
    });
    expect(read.lens).toBe("report");
    expect(read.document).toEqual(report.document);
    expect(read.sections).toEqual([{ ref: "outcomes", gist: "Outcomes", counts: { outcomes: 1 } }]);
    expect(read.elements.find((element) => element.kind === "round_outcome")).toMatchObject({
      id: "outcome-1",
      data: { status: "addressed" },
    });
  });

  it.each([
    ["missing metadata", undefined],
    [
      "another session",
      {
        lens: "report",
        boardId: "report-1",
        session: "session-elsewhere",
        generation: "gen-2",
      },
    ],
    [
      "another generation",
      {
        lens: "report",
        boardId: "report-1",
        session: "session-1",
        generation: "gen-elsewhere",
      },
    ],
    [
      "a non-report lens",
      {
        lens: "design",
        boardId: "report-1",
        session: "session-1",
        generation: "gen-2",
      },
    ],
  ])("omits the report projection for %s", async (_case, meta) => {
    const readElements = vi.fn(async () => []);
    const report = await readRoundReportBoardForRecord(
      {
        record: {
          asksDispatched: ["ask-1"],
          workerCommitRange: { from: "c0", to: "c1" },
          boardGeneration: "gen-2",
          reportBoard: "report-1",
        },
        sessionId: "session-1",
        reportBoardId: "report-1",
      },
      { loadMeta: () => meta, readElements },
    );

    expect(report).toBeUndefined();
    expect(readElements).not.toHaveBeenCalled();
  });
});
