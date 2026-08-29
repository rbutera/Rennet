import {
  buildHunkIndex,
  buildSnapshot,
  type LoadedSnapshot,
  materializeSnapshot,
  type SnapshotStructuralInputs,
  taughtHunkIds,
} from "@rennet/core";
import type {
  BaseRefResolution,
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
});

// ── The snapshot half of the packet (context-map rebuild, W5b) ────────────────
//
// `src/importer.ts` imports the changed `src/a.ts`. That one edge is what makes
// both assertions below able to fail: it is a REAL dependent for fan-in to count,
// and it is the 1-hop ring the knowledge scope is drawn around.

function fixtureSnapshot(options: { omitImports?: boolean } = {}): LoadedSnapshot {
  const files = ["src/a.ts", "src/importer.ts", "src/new.ts"];
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
          { blobOid: "blob:src/importer.ts", extractor: "structural-imports-v1", imports: ["./a"] },
          { blobOid: "blob:src/new.ts", extractor: "structural-imports-v1", imports: [] },
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
