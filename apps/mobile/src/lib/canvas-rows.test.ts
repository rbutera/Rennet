import { describe, expect, it } from "vitest";
import { type CanvasElement, flattenCanvasRows, splitHunks } from "./canvas-rows";

describe("splitHunks (#383 batch)", () => {
  it("splits a unified diff into its @@ hunks", () => {
    const diff = ["@@ -1,2 +1,2 @@", "-a", "+b", "@@ -10,1 +10,1 @@", "-c", "+d"].join("\n");
    expect(splitHunks(diff)).toHaveLength(2);
  });

  it("treats a marker-less diff as one hunk", () => {
    expect(splitHunks("+just one line")).toEqual(["+just one line"]);
  });
});

describe("flattenCanvasRows (#383 batch, finding 16)", () => {
  const elements: CanvasElement[] = [
    {
      key: "e1",
      path: "src/a.ts",
      diff: ["@@ -1,1 +1,1 @@", "-x", "+y", "@@ -9,1 +9,1 @@", "-p", "+q"].join("\n"),
    },
    { key: "e2", path: "src/b.ts", diff: "@@ -1,1 +1,1 @@\n-m\n+n" },
  ];

  it("emits a file header row plus one row per hunk, in reading order", () => {
    const rows = flattenCanvasRows(elements);
    // file a: 1 header + 2 hunks; file b: 1 header + 1 hunk = 5 rows.
    expect(rows.map((r) => r.type)).toEqual(["file", "hunk", "hunk", "file", "hunk"]);
    expect(rows[0]).toMatchObject({ type: "file", path: "src/a.ts" });
    // Keys are unique and stable per hunk index.
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("keeps a large single-file diff as many hunk rows, not one giant row", () => {
    const big: CanvasElement = {
      key: "big",
      path: "src/huge.ts",
      diff: Array.from({ length: 50 }, (_, i) => `@@ -${i},1 +${i},1 @@\n-a\n+b`).join("\n"),
    };
    const rows = flattenCanvasRows([big]);
    const hunkRows = rows.filter((r) => r.type === "hunk");
    expect(hunkRows.length).toBe(50); // virtualizable per hunk, not one 150-line row
  });
});
