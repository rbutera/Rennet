import type { Patchset } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { changesetShape, narrationFeedLines } from "./generation-narration";

function patchsetOf(files: Partial<Patchset["files"][number]>[]): Patchset {
  return {
    id: "ps",
    createdAt: "2026-08-09T00:00:00Z",
    repository: {
      id: "repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    } as unknown as Patchset["repository"],
    files: files.map((file) => ({
      path: file.path ?? "a.ts",
      status: file.status ?? "modified",
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      binary: file.binary ?? false,
      patch: file.patch ?? "",
    })),
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

describe("changesetShape", () => {
  it("counts real hunks (@@ markers), sums adds/dels, and skips binary files", () => {
    const shape = changesetShape(
      patchsetOf([
        { path: "src/a.ts", additions: 10, deletions: 3, patch: "@@ -1 +1 @@\n@@ -9 +9 @@\n" },
        { path: "img.png", binary: true, additions: 0, deletions: 0, patch: "GIT binary patch" },
        { path: "src/b.ts", additions: 4, deletions: 0, patch: "@@ -2 +2 @@\n" },
      ]),
    );
    expect(shape.fileCount).toBe(3);
    expect(shape.hunkCount).toBe(3); // 2 in a.ts, 0 in the binary, 1 in b.ts
    expect(shape.additions).toBe(14);
    expect(shape.deletions).toBe(3);
    expect(shape.files.find((f) => f.path === "img.png")?.hunks).toBe(0);
  });

  it("is null-safe on a missing patchset and on null add/del counts", () => {
    expect(changesetShape(undefined)).toEqual({
      fileCount: 0,
      hunkCount: 0,
      additions: 0,
      deletions: 0,
      files: [],
    });
    const shape = changesetShape(
      patchsetOf([{ path: "x.ts", additions: null, deletions: null, patch: "@@ -1 +1 @@\n" }]),
    );
    expect(shape.additions).toBe(0);
    expect(shape.deletions).toBe(0);
    expect(shape.hunkCount).toBe(1);
  });
});

describe("narrationFeedLines", () => {
  it("leads with the real changeset summary, then names the largest files, then the pipeline stages", () => {
    const lines = narrationFeedLines(
      changesetShape(
        patchsetOf([
          { path: "big.ts", additions: 40, deletions: 2, patch: "@@ a @@\n@@ b @@\n@@ c @@\n" },
          { path: "small.ts", additions: 1, deletions: 0, patch: "@@ a @@\n" },
        ]),
      ),
    );

    // Facts first: the summary carries real, pluralised counts.
    expect(lines[0]).toMatchObject({ kind: "summary", label: "Reading the changeset" });
    expect(lines[0]?.detail).toBe("2 files, 4 hunks, +41 −2");

    // The largest file is named first (real hunk count), and only files with hunks appear.
    const fileLines = lines.filter((l) => l.kind === "file");
    expect(fileLines.map((l) => l.label)).toEqual(["big.ts", "small.ts"]);
    expect(fileLines[0]?.detail).toBe("3 hunks");
    expect(fileLines[1]?.detail).toBe("1 hunk");

    // The real deterministic pipeline stages are present, in order, and never claim completion.
    const stages = lines.filter((l) => l.kind === "stage").map((l) => l.id);
    expect(stages).toEqual(["decompose", "budget", "angles", "order", "narrate"]);
  });

  it("degrades honestly for an empty changeset (no bare spinner: a real 'empty' summary)", () => {
    const lines = narrationFeedLines(changesetShape(patchsetOf([])));
    expect(lines[0]?.detail).toBe("an empty changeset");
    expect(lines.some((l) => l.kind === "file")).toBe(false);
    expect(lines.filter((l) => l.kind === "stage")).toHaveLength(5);
  });
});
