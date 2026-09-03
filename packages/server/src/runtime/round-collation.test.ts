import {
  buildHunkIndex,
  buildSnapshot,
  type LoadedSnapshot,
  lint,
  lintReviewDraft,
  materializeSnapshot,
  REGION_OPEN_END,
  resolveCitation,
  type SnapshotStructuralInputs,
} from "@rennet/core";
import {
  type BaseRefResolution,
  DIFF_TRUNCATION_MARKER,
  type DraftBoard,
  type DraftElement,
  type PatchFile,
  type Patchset,
  type SuccessorAccount,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { assembleRoundCollation, buildLintContextFor, changedRegions } from "./round-collation";

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

describe("changedRegions", () => {
  it("emits one region per hunk per side, a rename's base side under BOTH its names", () => {
    const regions = changedRegions(buildHunkIndex(PS), PS.files);
    expect(regions).toEqual([
      { path: "src/a.ts", side: "head", start: 1, end: 4 },
      { path: "src/a.ts", side: "base", start: 1, end: 3 },
      { path: "src/new.ts", side: "head", start: 10, end: 11 },
      { path: "src/old.ts", side: "base", start: 10, end: 11 },
      { path: "src/new.ts", side: "base", start: 10, end: 11 },
    ]);
  });

  it("a head-side citation over a region's range resolves; one past it does not (control)", () => {
    const regions = changedRegions(buildHunkIndex(PS), PS.files);
    expect(resolveCitation({ path: "src/a.ts", side: "head", start: 2, end: 3 }, regions)).toEqual({
      path: "src/a.ts",
      side: "head",
      start: 1,
      end: 4,
    });
    expect(
      resolveCitation({ path: "src/a.ts", side: "head", start: 99, end: 100 }, regions),
    ).toBeUndefined();
    // A rename's base side answers to either name — the seat reads `git diff` and writes
    // "the base side of src/new.ts" as readily as "src/old.ts" — but never the head side of
    // the old name, which no longer exists.
    expect(
      resolveCitation({ path: "src/new.ts", side: "base", start: 10, end: 10 }, regions),
    ).toBeDefined();
    expect(
      resolveCitation({ path: "src/old.ts", side: "base", start: 10, end: 10 }, regions),
    ).toBeDefined();
    expect(
      resolveCitation({ path: "src/old.ts", side: "head", start: 10, end: 10 }, regions),
    ).toBeUndefined();
  });

  it("a base-side citation under a rename's NEW name passes lint whole: no pointer of either rule", () => {
    const ctx = buildLintContextFor(PS, changedRegions(buildHunkIndex(PS), PS.files))("flagged");
    const citing = (path: string): DraftBoard =>
      ({
        elements: [
          {
            id: "c-base",
            kind: "code_ref",
            data: {
              author: { kind: "lens-agent", id: "seat" },
              patchset_id: "ps-collation",
              path,
              side: "base",
              start_line: 10,
              end_line: 11,
            },
          } as unknown as DraftElement,
        ],
      }) as unknown as DraftBoard;
    const citationRules = (board: DraftBoard) =>
      lint(board, ctx)
        .map((v) => v.ruleId)
        .filter((rule) => rule === "citation-resolves" || rule === "unresolvable-citation");
    // Before this, `{path: new, side: base}` earned TWO pointers — "no such file" from the
    // inventory and "no changed lines on the base side" from the regions — naming neither
    // name the seat could have used.
    expect(citationRules(citing("src/new.ts"))).toEqual([]);
    expect(citationRules(citing("src/old.ts"))).toEqual([]);
  });

  it("a truncated capture gets one open-ended region per side past its last parsed hunk", () => {
    // The seat reads the whole `git diff`; the daemon captured only up to the cap. A line
    // past the cut is not "outside the change" — the daemon does not know — so it resolves.
    const lossy = patchset([
      file({ path: "src/a.ts", patch: `${MODIFIED_PATCH}\n${DIFF_TRUNCATION_MARKER}` }),
      file({
        path: "src/fresh.ts",
        status: "added",
        patch: `@@ -0,0 +1,2 @@\n+a\n+b\n${DIFF_TRUNCATION_MARKER}`,
      }),
    ]);
    const regions = changedRegions(buildHunkIndex(lossy), lossy.files);
    expect(regions).toContainEqual({
      path: "src/a.ts",
      side: "head",
      start: 5,
      end: REGION_OPEN_END,
    });
    expect(regions).toContainEqual({
      path: "src/a.ts",
      side: "base",
      start: 4,
      end: REGION_OPEN_END,
    });
    expect(
      resolveCitation({ path: "src/a.ts", side: "head", start: 500, end: 510 }, regions),
    ).toBeDefined();
    // An ADDED file has no base side, truncated or not.
    expect(regions.filter((r) => r.path === "src/fresh.ts").map((r) => r.side)).toEqual([
      "head",
      "head",
    ]);
    // Control: the same citation against the complete capture is outside the change.
    expect(
      resolveCitation(
        { path: "src/a.ts", side: "head", start: 500, end: 510 },
        changedRegions(buildHunkIndex(PS), PS.files),
      ),
    ).toBeUndefined();
  });
});

describe("buildLintContextFor", () => {
  it("builds head + base file inventories, the patchsetId, and varies only lens", () => {
    const regions = changedRegions(buildHunkIndex(PS), PS.files);
    const ctxFor = buildLintContextFor(PS, regions);
    const design = ctxFor("design");

    expect(design.lens).toBe("design");
    expect(design.patchsetId).toBe("ps-collation");
    expect(design.regions).toBe(regions); // the changed regions, same for every lens
    // Head inventory: a.ts reaches new line 1+4-1=4; new.ts reaches 10+2-1=11.
    expect(design.files.get("src/a.ts")).toBe(4);
    expect(design.files.get("src/new.ts")).toBe(11);
    // Base inventory: a.ts old reaches 1+3-1=3; the rename's OLD path old.ts reaches 10+2-1=11.
    expect(design.baseFiles?.get("src/a.ts")).toBe(3);
    expect(design.baseFiles?.get("src/old.ts")).toBe(11);

    // Only `lens` differs across lenses — the universe is shared.
    const noise = ctxFor("noise");
    expect(noise.lens).toBe("noise");
    expect(noise.regions).toBe(design.regions);
    expect(noise.files).toBe(design.files);
  });
});

// ── W5: grounding is the WHOLE TREE, not the diff ────────────────────────────
// A drafter is free to read past the changed files. Grounding `citation-resolves`
// on `patchset.files` alone made every off-diff citation "no such file at the
// review commit", so the pipeline DELETED correct findings with no signal to the
// seat that wrote them. These are the control: the same citation, the same lint,
// the only difference being whether the real tree inventory was supplied.

describe("buildLintContextFor — whole-tree citation grounding", () => {
  const AUTHOR = { kind: "lens-agent" as const, id: "drafter" };

  /** A one-element board citing `path:start-end` on the head side. */
  const boardCiting = (path: string, start: number, end: number): DraftBoard =>
    ({
      elements: [
        {
          id: "c-off",
          kind: "code_ref",
          data: {
            author: AUTHOR,
            patchset_id: "ps-collation",
            path,
            side: "head",
            start_line: start,
            end_line: end,
          },
        } as unknown as DraftElement,
      ],
    }) as unknown as DraftBoard;

  const unresolved = (board: DraftBoard, tree?: Parameters<typeof buildLintContextFor>[2]) =>
    lint(
      board,
      buildLintContextFor(PS, changedRegions(buildHunkIndex(PS), PS.files), tree)("design"),
    )
      .filter((v) => v.ruleId === "citation-resolves")
      .map((v) => v.message);

  it("grounds citation-resolves for an off-diff file on the tree inventory (unresolvable-citation still reports it)", () => {
    const board = boardCiting("src/untouched.ts", 120, 130);
    // Diff-only grounding (what shipped before W5) calls the real file a ghost.
    expect(unresolved(board)).toHaveLength(1);
    // The tree at the review commit knows the file, so the finding survives.
    const tree = { head: new Map([["src/untouched.ts", 400]]), base: new Map() };
    expect(unresolved(board, tree)).toHaveLength(0);
  });

  it("still rejects a citation past the real end of an off-diff file", () => {
    const tree = { head: new Map([["src/untouched.ts", 100]]), base: new Map() };
    expect(unresolved(boardCiting("src/untouched.ts", 120, 130), tree)).toHaveLength(1);
  });

  it("still rejects a citation into a file that is not in the tree at all", () => {
    const tree = { head: new Map([["src/untouched.ts", 400]]), base: new Map() };
    expect(unresolved(boardCiting("src/ghost.ts", 1, 2), tree)).toHaveLength(1);
  });

  it("never LOWERS a ceiling the diff already earned (working-tree reviews)", () => {
    // A working-tree review's patch describes uncommitted content, so the tree read
    // — pinned to the commit — can be SHORTER. Taking it would reject a citation
    // inside the change's own hunk, which always resolved before W5.
    const tree = { head: new Map([["src/a.ts", 2]]), base: new Map() };
    const ctx = buildLintContextFor(
      PS,
      changedRegions(buildHunkIndex(PS), PS.files),
      tree,
    )("design");
    expect(ctx.files.get("src/a.ts")).toBe(4);
    expect(unresolved(boardCiting("src/a.ts", 3, 4), tree)).toHaveLength(0);
  });

  it("prefers the tree's true line count over the extent the patch happens to reach", () => {
    // `src/a.ts`'s patch only reaches new line 4; the file is really 400 lines, and a
    // citation at line 200 is legitimate.
    const tree = { head: new Map([["src/a.ts", 400]]), base: new Map([["src/a.ts", 380]]) };
    const ctx = buildLintContextFor(
      PS,
      changedRegions(buildHunkIndex(PS), PS.files),
      tree,
    )("design");
    expect(ctx.files.get("src/a.ts")).toBe(400);
    expect(ctx.baseFiles?.get("src/a.ts")).toBe(380);
    expect(unresolved(boardCiting("src/a.ts", 200, 210), tree)).toHaveLength(0);
  });
});

describe("assembleRoundCollation", () => {
  it("threads a successor account so the packet is a ROUND (isRound fires)", () => {
    const successorAccount: SuccessorAccount = { asks: [], beyondAsks: [] };
    const c = assembleRoundCollation({
      patchset: PS,
      dossier: [],
      successorAccount,
    });
    expect(c.deltaPacket.successorAccount).toBeDefined(); // isRound branch fires
    expect(c.lintContextFor("design").regions).toHaveLength(5); // derived off the same packet
    expect(c.lintContextFor("design").patchsetId).toBe("ps-collation");
  });

  it("degrades to a first-generation (non-round) packet when no successor account", () => {
    const c = assembleRoundCollation({ patchset: PS, dossier: [] });
    expect(c.deltaPacket.successorAccount).toBeUndefined(); // first-generation, not a crash
    expect(c.lintContextFor("design").regions).toHaveLength(5);
  });

  // W5 finding 2 — the SAME grounding, one layer up. The composed review draft is the
  // surface the reviewer actually reads; it was linted against an empty inventory, so
  // every real `path:line` in it reported "no such file at the review commit".
  it("grounds the review draft on the same head inventory as the boards", () => {
    const tree = { head: new Map([["src/untouched.ts", 400]]), base: new Map() };
    const c = assembleRoundCollation({ patchset: PS, dossier: [], tree });
    // The off-diff file the tree read found...
    expect(c.reviewDraftLintCtx.files.get("src/untouched.ts")).toBe(400);
    // ...and the diff-derived ceiling, unlowered — byte-identical to the boards' own.
    expect(c.reviewDraftLintCtx.files).toEqual(c.lintContextFor("design").files);

    const prose = "The refresh guard at src/untouched.ts:200 is correct.";
    expect(lintReviewDraft(prose, c.reviewDraftLintCtx)).toEqual([]);
    // POSITIVE CONTROL: the empty inventory this used to receive rejects that citation.
    expect(lintReviewDraft(prose, { files: new Map() }).map((v) => v.ruleId)).toEqual([
      "citation-resolves",
    ]);
  });
});

// ── The snapshot half of the packet (context-map rebuild, W5b) ────────────────
//
// `src/importer.ts` imports the changed `src/a.ts`. That one edge is what makes
// both assertions below able to fail: it is a REAL dependent for fan-in to count,
// and it is the 1-hop import ring around the change.

function fixtureSnapshot(
  options: { omitImports?: boolean; withOldPath?: boolean } = {},
): LoadedSnapshot {
  const files = ["src/a.ts", "src/importer.ts", "src/new.ts"];
  // The rename's BASE side. Present only when a test needs the base to be able to
  // answer about `src/old.ts` — which is the whole point of the per-file check.
  if (options.withOldPath) files.push("src/old.ts");
  const inputs: SnapshotStructuralInputs = {
    repoKey: "/repo/.git",
    baseRef: "main",
    baseRefResolution: "symbolic-head" as BaseRefResolution,
    baseOid: "0".repeat(40),
    files: files.map((path) => ({ path, blobOid: `blob:${path}`, size: 1, mode: "100644" })),
    scopes: [],
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
  };
  const built = buildSnapshot(
    inputs,
    [],
    [],
    options.omitImports
      ? []
      : [
          { blobOid: "blob:src/a.ts", extractor: "structural-imports-v1", imports: [] },
          {
            blobOid: "blob:src/importer.ts",
            extractor: "structural-imports-v1",
            imports: options.withOldPath ? ["./a", "./old"] : ["./a"],
          },
          { blobOid: "blob:src/new.ts", extractor: "structural-imports-v1", imports: [] },
          ...(options.withOldPath
            ? [{ blobOid: "blob:src/old.ts", extractor: "structural-imports-v1", imports: [] }]
            : []),
        ],
  );
  const materialized = materializeSnapshot(built.manifest, (digest) => built.shards.get(digest));
  if (!materialized.ok) throw new Error(`materialize failed: ${materialized.slots.join(",")}`);
  return materialized.snapshot;
}

/** The review-scoped fan-in mark — the one that says whether fan-in was assessed at all. */
function fanInMark(collation: ReturnType<typeof assembleRoundCollation>) {
  return collation.deltaPacket.blastRadius.find(
    (mark) => mark.target === "rennet:review/blast-radius" && mark.signal === "fan-in",
  );
}

describe("assembleRoundCollation — fan-in is wired to the snapshot", () => {
  it("with the import shard present, blast radius carries an EDGE-BACKED count", () => {
    const c = assembleRoundCollation({
      patchset: PS,
      snapshot: fixtureSnapshot(),
      dossier: [],
    });
    expect(fanInMark(c)?.assessed).toBe(true);
    // The wording is the honest half: an edge-backed claim must never be able to
    // read as the textual one, so the reason names the import graph.
    expect(fanInMark(c)?.reason).toContain("import graph");
    const perFile = c.deltaPacket.blastRadius.find(
      (mark) => mark.signal === "fan-in" && mark.target === "rennet:file/src/a.ts",
    );
    expect(perFile?.reason).toBe("1 file imports this file; changes here ripple to them.");
  });

  it("CONTROL: without a snapshot the mark stays NOT ASSESSED, as it was before", () => {
    const c = assembleRoundCollation({ patchset: PS, dossier: [] });
    expect(fanInMark(c)?.assessed).toBe(false);
    expect(fanInMark(c)?.reason).toContain("not assessed");
  });

  it("a snapshot that can answer NOTHING supplies no index — not a silent zero", () => {
    // No import shards and no reference shards: the textual arm would answer "zero
    // dependents" for every file, which would render as "checked, nothing depends
    // on this". Withholding the index keeps the mark honestly not-assessed.
    const c = assembleRoundCollation({
      patchset: PS,
      snapshot: fixtureSnapshot({ omitImports: true }),
      dossier: [],
    });
    expect(fanInMark(c)?.assessed).toBe(false);
  });

  it("REFERENCE shards without SYMBOL shards still supply no index — the join needs both", () => {
    // The textual lookup is a JOIN: `definedSymbols` reads the symbol shards and
    // `referencingFiles` the reference ones. With references present and symbols
    // absent, every changed file defines nothing, so every count is zero — the same
    // silent zero as an empty index, reached from the other side. Control: drop the
    // `symbolDigestByBlob` term from `packetFanIn` and this reddens to assessed:true.
    const built = buildSnapshot(
      {
        repoKey: "/repo/.git",
        baseRef: "main",
        baseRefResolution: "symbolic-head" as BaseRefResolution,
        baseOid: "0".repeat(40),
        files: ["src/a.ts"].map((path) => ({
          path,
          blobOid: `blob:${path}`,
          size: 1,
          mode: "100644",
        })),
        scopes: [],
        edges: [],
        entryPoints: [],
        tests: [],
        ownership: [],
        conventions: [],
      },
      [], // no symbol shards
      [
        {
          blobOid: "blob:src/a.ts",
          extractor: "structural-references-v1",
          references: [{ name: "foo", lines: [1] }],
        },
      ],
      [], // no import shards, so the edge-backed arm is unavailable
    );
    const materialized = materializeSnapshot(built.manifest, (digest) => built.shards.get(digest));
    if (!materialized.ok) throw new Error(`materialize failed: ${materialized.slots.join(",")}`);
    expect(materialized.snapshot.referenceDigestByBlob.size).toBeGreaterThan(0);
    expect(materialized.snapshot.symbolDigestByBlob.size).toBe(0);

    const c = assembleRoundCollation({
      patchset: PS,
      snapshot: materialized.snapshot,
      dossier: [],
    });
    expect(fanInMark(c)?.assessed).toBe(false);
  });

  it("a RENAME is counted at its previous path; a path the base lacks is NOT ASSESSED", () => {
    const withOld = assembleRoundCollation({
      patchset: PS,
      snapshot: fixtureSnapshot({ withOldPath: true }),
      dossier: [],
    });
    const renamed = withOld.deltaPacket.blastRadius.find(
      (mark) => mark.signal === "fan-in" && mark.target === "rennet:file/src/new.ts",
    );
    // `src/importer.ts` imports `./old`, never `./new` — the count can only come from
    // the base-side path. Marked on the visible (new) element, counted at the old one.
    expect(renamed?.assessed).toBe(true);
    expect(renamed?.reason).toBe("1 file imports this file; changes here ripple to them.");

    // CONTROL, same patchset over a base that never carried `src/old.ts`: the honest
    // answer is not-assessed. A zero here would read as "checked, nothing depends on it".
    const withoutOld = assembleRoundCollation({
      patchset: PS,
      snapshot: fixtureSnapshot(),
      dossier: [],
    });
    const absent = withoutOld.deltaPacket.blastRadius.find(
      (mark) => mark.signal === "fan-in" && mark.target === "rennet:file/src/new.ts",
    );
    expect(absent?.assessed).toBe(false);
    expect(absent?.reason).toContain("src/old.ts");
    // The repo-wide index is still assessed — this is per-file availability, not a
    // whole signal going dark.
    expect(fanInMark(withoutOld)?.assessed).toBe(true);
  });
});
