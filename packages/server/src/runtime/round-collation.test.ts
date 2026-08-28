import { buildHunkIndex, taughtHunkIds } from "@rennet/core";
import type { DraftElement, PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildLintContextFor, toLintHunks } from "./round-collation";

// A modified file with ONE hunk: old 1..3 (3 lines), new 1..4 (4 lines).
const MODIFIED_PATCH = [
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
].join("\n");

// A renamed file with ONE hunk: old 10..11, new 10..11.
const RENAMED_PATCH = ["@@ -10,2 +10,2 @@", " x", "-y", "+z"].join("\n");

function file(overrides: Partial<PatchFile> & Pick<PatchFile, "path" | "patch">): PatchFile {
  return {
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    ...overrides,
  };
}

function patchset(files: PatchFile[]): Patchset {
  return {
    id: "ps-collation",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files,
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

const PS = patchset([
  file({ path: "src/a.ts", patch: MODIFIED_PATCH }),
  file({
    path: "src/new.ts",
    previousPath: "src/old.ts",
    status: "renamed",
    patch: RENAMED_PATCH,
  }),
]);

describe("toLintHunks", () => {
  it("maps indexed-hunk spans to the flat LintHunk shape, base path only on a rename", () => {
    const index = buildHunkIndex(PS);
    const lint = toLintHunks(index, PS.files);
    expect(lint).toHaveLength(2);

    const a = lint.find((h) => h.path === "src/a.ts");
    expect(a).toMatchObject({
      path: "src/a.ts",
      newStart: 1,
      newLines: 4,
      oldStart: 1,
      oldLines: 3,
    });
    expect(a?.previousPath).toBeUndefined(); // not renamed
    expect(a?.id).toBe(index.hunks.find((h) => h.path === "src/a.ts")?.id); // id carried verbatim

    const renamed = lint.find((h) => h.path === "src/new.ts");
    expect(renamed).toMatchObject({
      path: "src/new.ts",
      newStart: 10,
      newLines: 2,
      oldStart: 10,
      oldLines: 2,
      previousPath: "src/old.ts", // base-side resolves against the OLD path
    });
  });

  it("emits a hunk that a head-side citation over its new range TEACHES (coverage control)", () => {
    const lint = toLintHunks(buildHunkIndex(PS), PS.files);
    const aHunk = lint.find((h) => h.path === "src/a.ts");
    if (aHunk === undefined) throw new Error("missing hunk");
    // A code_ref over the hunk's new range teaches it…
    const inside: DraftElement = {
      id: "c1",
      kind: "code_ref",
      data: { path: "src/a.ts", side: "head", start_line: 2, end_line: 3 },
    } as unknown as DraftElement;
    expect(taughtHunkIds([inside], lint).has(aHunk.id)).toBe(true);
    // …a citation past the hunk's range does NOT — so a dropped/mis-ranged hunk fails coverage.
    const outside: DraftElement = {
      id: "c2",
      kind: "code_ref",
      data: { path: "src/a.ts", side: "head", start_line: 99, end_line: 100 },
    } as unknown as DraftElement;
    expect(taughtHunkIds([outside], lint).has(aHunk.id)).toBe(false);
  });
});

describe("buildLintContextFor", () => {
  it("builds head + base file inventories, the patchsetId, and varies only lens", () => {
    const lint = toLintHunks(buildHunkIndex(PS), PS.files);
    const ctxFor = buildLintContextFor(PS, lint);
    const design = ctxFor("design");

    expect(design.lens).toBe("design");
    expect(design.patchsetId).toBe("ps-collation");
    expect(design.hunks).toBe(lint); // the full hunk universe, same for every lens
    // Head inventory: a.ts reaches new line 1+4-1=4; new.ts reaches 10+2-1=11.
    expect(design.files.get("src/a.ts")).toBe(4);
    expect(design.files.get("src/new.ts")).toBe(11);
    // Base inventory: a.ts old reaches 1+3-1=3; the rename's OLD path old.ts reaches 10+2-1=11.
    expect(design.baseFiles?.get("src/a.ts")).toBe(3);
    expect(design.baseFiles?.get("src/old.ts")).toBe(11);

    // Only `lens` differs across lenses — the universe is shared.
    const noise = ctxFor("noise");
    expect(noise.lens).toBe("noise");
    expect(noise.hunks).toBe(design.hunks);
    expect(noise.files).toBe(design.files);
  });
});
