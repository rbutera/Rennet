import type { PatchFile, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { activePatchsetFiles } from "./diff-source";

// activePatchsetFiles reads only `patchsets` and `activePatchsetId`; the rest of the
// Review shape is irrelevant to the projection selection, so a focused builder casts the
// two load-bearing fields (the container hands it a fully-resolved Review at runtime).
function reviewWith(
  patchsets: Array<{ id: string; files: PatchFile[] }>,
  activePatchsetId: string,
): Review {
  return { patchsets, activePatchsetId } as unknown as Review;
}

function patchFile(path: string): PatchFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `@@ -1,1 +1,1 @@\n-a\n+b`,
  };
}

describe("activePatchsetFiles", () => {
  it("selects the files of the patchset named by activePatchsetId", () => {
    const review = reviewWith(
      [
        { id: "ps-old", files: [patchFile("old.ts")] },
        { id: "ps-new", files: [patchFile("a.ts"), patchFile("b.ts")] },
      ],
      "ps-new",
    );
    expect(activePatchsetFiles(review).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("returns [] when the active patchset has no files", () => {
    const review = reviewWith([{ id: "ps", files: [] }], "ps");
    expect(activePatchsetFiles(review)).toEqual([]);
  });

  it("returns [] when activePatchsetId matches no patchset (honest empty, never a crash)", () => {
    const review = reviewWith([{ id: "ps", files: [patchFile("a.ts")] }], "missing");
    expect(activePatchsetFiles(review)).toEqual([]);
  });
});
