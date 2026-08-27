import { describe, expect, it } from "vitest";
import { lineRef, refKey, type SpanRead, spanToBlock } from "./citations";

describe("citations — pure helpers", () => {
  it("lineRef defaults endLine to startLine and side to head", () => {
    expect(lineRef("ps", "a/b.ts", 12)).toEqual({
      patchsetId: "ps",
      path: "a/b.ts",
      side: "head",
      startLine: 12,
      endLine: 12,
    });
    expect(lineRef("ps", "a/b.ts", 12, 20, "base")).toEqual({
      patchsetId: "ps",
      path: "a/b.ts",
      side: "base",
      startLine: 12,
      endLine: 20,
    });
  });

  it("refKey separates refs that differ only by side, path, patchset, or span", () => {
    const base = lineRef("ps", "a/b.ts", 5, 5, "head");
    expect(refKey(base)).toBe(refKey(lineRef("ps", "a/b.ts", 5, 5, "head")));
    expect(refKey(base)).not.toBe(refKey(lineRef("ps", "a/b.ts", 5, 5, "base")));
    expect(refKey(base)).not.toBe(refKey(lineRef("ps", "a/c.ts", 5, 5, "head")));
    expect(refKey(base)).not.toBe(refKey(lineRef("ps2", "a/b.ts", 5, 5, "head")));
    expect(refKey(base)).not.toBe(refKey(lineRef("ps", "a/b.ts", 5, 6, "head")));
  });

  it("spanToBlock orders context around the cited lines, derives the start line, highlights the span", () => {
    const ref = lineRef("ps", "a/b.ts", 42, 44);
    const span: SpanRead = {
      lines: ["L42", "L43", "L44"],
      contextBefore: ["L40", "L41"],
      contextAfter: ["L45"],
    };
    const block = spanToBlock(ref, span);
    // Context BEFORE, cited lines, context AFTER — in that order.
    expect(block.code).toBe("L40\nL41\nL42\nL43\nL44\nL45");
    // Absolute start = the cited startLine minus the leading context (cannot drift).
    expect(block.startLine).toBe(40);
    // Exactly the cited range is highlighted.
    expect(block.highlightLines).toEqual([42, 43, 44]);
  });
});
