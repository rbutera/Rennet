import { describe, expect, it } from "vitest";
import { evidenceRows } from "./evidence-block";

const ref = {
  patchsetId: "ps",
  path: "src/renamed.ts",
  side: "head" as const,
  startLine: 3,
  endLine: 3,
};
const evidence = {
  patch: "@@ -2,3 +2,4 @@\n before\n-old\n+new\n+extra\n after\n",
  path: ref.path,
  counterparts: [],
  base: "start\nbefore\nold\nafter\nend\n",
  head: "start\nbefore\nnew\nextra\nafter\nend\n",
};

describe("review evidence rows", () => {
  it("shows both sides of the complete cited hunk, including uncited changes", () => {
    expect(evidenceRows(evidence, ref, 0)).toEqual([
      { type: "context", text: "before", oldLine: 2, newLine: 2 },
      { type: "del", text: "old", oldLine: 3, newLine: null },
      { type: "add", text: "new", oldLine: null, newLine: 3 },
      { type: "add", text: "extra", oldLine: null, newLine: 4 },
      { type: "context", text: "after", oldLine: 4, newLine: 5 },
    ]);
  });
  it("expands immutable context with the original old/new offset", () => {
    const rows = evidenceRows(evidence, ref, "all");
    expect(rows[0]).toEqual({ type: "context", text: "start", oldLine: 1, newLine: 1 });
    expect(rows.at(-1)).toEqual({ type: "context", text: "end", oldLine: 5, newLine: 6 });
    expect(rows.filter((row) => row.type === "del")).toHaveLength(1);
  });
  it("retains captured hunks when immutable source is unavailable", () => {
    expect(evidenceRows({ ...evidence, base: null, head: null }, ref, "all")).toEqual(
      evidenceRows(evidence, ref, 0),
    );
  });
  it("shows deleted full files exactly once", () => {
    const rows = evidenceRows(
      { ...evidence, patch: "@@ -1,2 +0,0 @@\n-one\n-two\n", base: "one\ntwo\n", head: null },
      { ...ref, side: "base", startLine: 1, endLine: 1 },
      "all",
    );
    expect(rows.map((row) => row.text)).toEqual(["one", "two"]);
    expect(rows.every((row) => row.newLine === null)).toBe(true);
  });
});
