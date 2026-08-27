import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BoardMetaInput, BoardMetaStore } from "./board-meta-store";

const meta = (boardId: string, lens: BoardMetaInput["lens"]): BoardMetaInput => ({
  lens,
  boardId,
  skippedHunks: [{ hunk: "h1", reason: "binary blob" }],
  blemishes: [{ ruleId: "prose-length", elementRef: "/e1", message: "too long" }],
  omissions: [{ elementId: "e2", hunks: ["h2"], reason: "not covered" }],
  immutability: [],
});

describe("BoardMetaStore", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "board-meta-"));

  it("round-trips a board's coverage/validation metadata through disk", () => {
    const store = new BoardMetaStore(dir());
    store.save(meta("board:design", "design"));
    const read = store.load("board:design");
    expect(read?.boardId).toBe("board:design");
    expect(read?.lens).toBe("design");
    expect(read?.skippedHunks).toEqual([{ hunk: "h1", reason: "binary blob" }]);
    expect(read?.blemishes).toEqual([
      { ruleId: "prose-length", elementRef: "/e1", message: "too long" },
    ]);
    expect(read?.omissions).toEqual([{ elementId: "e2", hunks: ["h2"], reason: "not covered" }]);
  });

  it("reconstructs the whole set with list()", () => {
    const store = new BoardMetaStore(dir());
    store.save(meta("board:design", "design"));
    store.save(meta("board:report", "report"));
    const ids = store
      .list()
      .map((m) => m.boardId)
      .sort();
    expect(ids).toEqual(["board:design", "board:report"]);
  });

  it("fails safe: a missing board reads back undefined, never a throw", () => {
    const store = new BoardMetaStore(dir());
    expect(store.load("board:absent")).toBeUndefined();
  });

  it("fails safe: a malformed file is undefined on read and skipped in list (left untouched)", () => {
    const d = dir();
    const store = new BoardMetaStore(d);
    store.save(meta("board:good", "noise"));
    writeFileSync(join(d, `${encodeURIComponent("board:bad")}.json`), "{ not json");
    expect(store.load("board:bad")).toBeUndefined();
    expect(store.list().map((m) => m.boardId)).toEqual(["board:good"]);
  });
});
