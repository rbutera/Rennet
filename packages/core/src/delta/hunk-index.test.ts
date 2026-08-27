import { DIFF_TRUNCATION_MARKER, type PatchFile } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildHunkIndex } from "./hunk-index";

function file(path: string, patch: string, overrides: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch,
    ...overrides,
  };
}

const PATCH = [
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "@@ -10,2 +10,3 @@",
  " const c = 4;",
  "+const d = 5;",
  " const e = 6;",
].join("\n");

describe("buildHunkIndex", () => {
  it("mints identical ids for the same patchset on every run", () => {
    const patchset = { files: [file("src/a.ts", PATCH)] };
    const first = buildHunkIndex(patchset);
    const second = buildHunkIndex(patchset);
    expect(first.hunks).toHaveLength(2);
    expect(first.hunks.map((h) => h.id)).toEqual(second.hunks.map((h) => h.id));
    expect(first.byId.get(first.hunks[0]?.id ?? "")).toEqual(first.hunks[0]);
  });

  it("changes the id when a body line changes", () => {
    const before = buildHunkIndex({ files: [file("src/a.ts", PATCH)] });
    const after = buildHunkIndex({
      files: [file("src/a.ts", PATCH.replace("const b = 3;", "const b = 9;"))],
    });
    expect(after.hunks[0]?.id).not.toBe(before.hunks[0]?.id);
    // The untouched second hunk keeps its id — identity is per hunk, not per file.
    expect(after.hunks[1]?.id).toBe(before.hunks[1]?.id);
  });

  it("flags every hunk of a truncated patch lossy, with ids still minted", () => {
    const truncated = `${PATCH}\n${DIFF_TRUNCATION_MARKER}`;
    const index = buildHunkIndex({ files: [file("src/a.ts", truncated)] });
    expect(index.hunks).toHaveLength(2);
    for (const hunk of index.hunks) {
      expect(hunk.lossy).toBe(true);
      expect(hunk.id).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(buildHunkIndex({ files: [file("src/a.ts", PATCH)] }).hunks[0]?.lossy).toBe(false);
  });

  it("yields no hunks and does not throw on empty and binary files", () => {
    const index = buildHunkIndex({
      files: [
        file("empty.ts", ""),
        file("image.png", "", { binary: true, additions: null, deletions: null }),
      ],
    });
    expect(index.hunks).toEqual([]);
    expect(index.byId.size).toBe(0);
  });

  it("carries the verbatim header, body, and both spans", () => {
    const [first] = buildHunkIndex({ files: [file("src/a.ts", PATCH)] }).hunks;
    expect(first?.header).toBe("@@ -1,3 +1,3 @@");
    expect(first?.body).toEqual([" const a = 1;", "-const b = 2;", "+const b = 3;"]);
    expect(first?.spans).toEqual({
      old: { start: 1, lines: 3 },
      new: { start: 1, lines: 3 },
    });
  });
});
