import {
  buildHunkIndex,
  buildSnapshot,
  type LoadedSnapshot,
  lint,
  lintReviewDraft,
  materializeSnapshot,
  type SnapshotStructuralInputs,
  taughtHunkIds,
} from "@rennet/core";
import type {
  BaseRefResolution,
  DraftBoard,
  DraftElement,
  KnowledgeSet,
  KnowledgeStatement,
  PatchFile,
  Patchset,
  SuccessorAccount,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { assembleRoundCollation, buildLintContextFor, toLintHunks } from "./round-collation";

const KNOWLEDGE: KnowledgeSet = {
  schemaVersion: 1,
  repoKey: "repo",
  baseOid: "0".repeat(40),
  snapshotFingerprint: "fp",
  generator: "test",
  statements: [],
};

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
      skippedHunks: [],
    }) as unknown as DraftBoard;

  const unresolved = (board: DraftBoard, tree?: Parameters<typeof buildLintContextFor>[2]) =>
    lint(board, buildLintContextFor(PS, toLintHunks(buildHunkIndex(PS), PS.files), tree)("design"))
      .filter((v) => v.ruleId === "citation-resolves")
      .map((v) => v.message);

  it("keeps a citation into a file the change never touched", () => {
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
    const ctx = buildLintContextFor(PS, toLintHunks(buildHunkIndex(PS), PS.files), tree)("design");
    expect(ctx.files.get("src/a.ts")).toBe(4);
    expect(unresolved(boardCiting("src/a.ts", 3, 4), tree)).toHaveLength(0);
  });

  it("prefers the tree's true line count over the extent the patch happens to reach", () => {
    // `src/a.ts`'s patch only reaches new line 4; the file is really 400 lines, and a
    // citation at line 200 is legitimate.
    const tree = { head: new Map([["src/a.ts", 400]]), base: new Map([["src/a.ts", 380]]) };
    const ctx = buildLintContextFor(PS, toLintHunks(buildHunkIndex(PS), PS.files), tree)("design");
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
      knowledge: KNOWLEDGE,
      dossier: [],
      successorAccount,
    });
    expect(c.deltaPacket.successorAccount).toBeDefined(); // isRound branch fires
    expect(c.hunks).toHaveLength(2); // derived off the same packet
    expect(c.lintContextFor("design").patchsetId).toBe("ps-collation");
  });

  it("degrades to a first-generation (non-round) packet when no successor account", () => {
    const c = assembleRoundCollation({ patchset: PS, knowledge: KNOWLEDGE, dossier: [] });
    expect(c.deltaPacket.successorAccount).toBeUndefined(); // first-generation, not a crash
    expect(c.hunks).toHaveLength(2);
  });

  // W5 finding 2 — the SAME grounding, one layer up. The composed review draft is the
  // surface the reviewer actually reads; it was linted against an empty inventory, so
  // every real `path:line` in it reported "no such file at the review commit".
  it("grounds the review draft on the same head inventory as the boards", () => {
    const tree = { head: new Map([["src/untouched.ts", 400]]), base: new Map() };
    const c = assembleRoundCollation({ patchset: PS, knowledge: KNOWLEDGE, dossier: [], tree });
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
// and it is the 1-hop ring the knowledge scope is drawn around.

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
      knowledge: KNOWLEDGE,
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
    const c = assembleRoundCollation({ patchset: PS, knowledge: KNOWLEDGE, dossier: [] });
    expect(fanInMark(c)?.assessed).toBe(false);
    expect(fanInMark(c)?.reason).toContain("not assessed");
  });

  it("a snapshot that can answer NOTHING supplies no index — not a silent zero", () => {
    // No import shards and no reference shards: the textual arm would answer "zero
    // dependents" for every file, which would render as "checked, nothing depends
    // on this". Withholding the index keeps the mark honestly not-assessed.
    const c = assembleRoundCollation({
      patchset: PS,
      knowledge: KNOWLEDGE,
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
      knowledge: KNOWLEDGE,
      snapshot: materialized.snapshot,
      dossier: [],
    });
    expect(fanInMark(c)?.assessed).toBe(false);
  });

  it("a RENAME is counted at its previous path; a path the base lacks is NOT ASSESSED", () => {
    const withOld = assembleRoundCollation({
      patchset: PS,
      knowledge: KNOWLEDGE,
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
      knowledge: KNOWLEDGE,
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

describe("assembleRoundCollation — the packet's knowledge is a selection, not the set", () => {
  function statement(id: string, subject: string, anchorPath: string): KnowledgeStatement {
    return {
      id,
      subject,
      aspect: "purpose",
      claim: `claim ${id}`,
      evidence: [{ path: anchorPath, blobOid: `blob:${anchorPath}` }],
      confidence: "high",
      status: "hypothesis",
      provenance: { generator: "g@1", model: null, apiKeySource: null },
      learnedAgainst: { baseOid: "0".repeat(40), snapshotFingerprint: "fp" },
    };
  }
  const REJECTED: KnowledgeStatement = {
    ...statement("k2-rejected", "src/a.ts", "src/a.ts"),
    status: "rejected",
  };
  const SET: KnowledgeSet = {
    ...KNOWLEDGE,
    statements: [statement("k1-changed", "src/a.ts", "src/a.ts"), REJECTED],
  };

  it("projects and scopes the stored set at the packet seam", () => {
    const c = assembleRoundCollation({
      patchset: PS,
      knowledge: SET,
      snapshot: fixtureSnapshot(),
      dossier: [],
    });
    expect(c.deltaPacket.knowledge.mode).toBe("import-graph");
    expect(c.deltaPacket.knowledge.statements.map((s) => s.id)).toEqual(["k1-changed"]);
    expect(c.deltaPacket.knowledge.counts.rejected).toBe(1);
    // The store total is disclosed, so the drafter can see there is more to ask for.
    expect(c.deltaPacket.knowledge.counts.inStore).toBe(2);
  });

  it("carries BOTH sides of a rename into the scope, so base-anchored knowledge survives", () => {
    // `src/old.ts` is only ever reachable as the rename's PREVIOUS path: nothing in
    // the fixture imports or is imported by it from a changed file, so the one-hop
    // ring cannot pull it in. Drop `previousPath` from the changed-path set and this
    // statement falls out of scope — the control this assertion rests on.
    const OLD = statement("k3-old", "src/old.ts", "src/old.ts");
    const c = assembleRoundCollation({
      patchset: PS,
      knowledge: { ...SET, statements: [...SET.statements, OLD] },
      snapshot: fixtureSnapshot({ withOldPath: true }),
      dossier: [],
    });
    expect(c.deltaPacket.knowledge.mode).toBe("import-graph");
    expect(c.deltaPacket.knowledge.statements.map((s) => s.id)).toContain("k3-old");
  });

  it("a repo that was never enriched is an honest empty selection, not a crash", () => {
    const c = assembleRoundCollation({
      patchset: PS,
      knowledge: null,
      snapshot: fixtureSnapshot(),
      dossier: [],
    });
    expect(c.deltaPacket.knowledge.statements).toEqual([]);
    expect(c.deltaPacket.knowledge.generator).toBeNull();
  });
});
