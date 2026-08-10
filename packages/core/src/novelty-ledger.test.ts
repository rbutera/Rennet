import { sha256Hex } from "@rennet/protocol";
import type {
  BaseRefResolution,
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  LedgerEntry,
  OwnershipRule,
  PatchFile,
  Patchset,
  SnapshotFileEntry,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/types";
import { DIFF_TRUNCATION_MARKER } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  classifyNovelty,
  classifyTestGlob,
  introducedExports,
  parseAddedLines,
  patchIsTruncated,
  scopeForPath,
} from "./novelty-ledger";
import { type LoadedSnapshot, materializeSnapshot, type ShardLoader } from "./project-context";
import { buildSnapshot, type SnapshotStructuralInputs } from "./project-snapshot";

// ── A coherent base-branch snapshot fixture, built through the real builder ────

const B_A = "blob-a"; // packages/core/src/a.ts — exports foo, Bar
const B_TEST = "blob-test"; // packages/core/src/a.test.ts — a known test
const B_MAIN = "blob-main"; // packages/app/src/main.ts — exports main
const B_JSON = "blob-json"; // biome.json — a convention config

const files: SnapshotFileEntry[] = [
  { path: "biome.json", blobOid: B_JSON, size: 20, mode: "100644" },
  { path: "packages/app/src/main.ts", blobOid: B_MAIN, size: 20, mode: "100644" },
  { path: "packages/core/src/a.test.ts", blobOid: B_TEST, size: 10, mode: "100644" },
  { path: "packages/core/src/a.ts", blobOid: B_A, size: 40, mode: "100644" },
];

const scopes: WorkspaceScope[] = [
  { name: "@x/core", root: "packages/core", type: "library", private: true, tags: [] },
  { name: "@x/app", root: "packages/app", type: "application", private: true, tags: [] },
];

const edges: DependencyEdge[] = [{ from: "@x/app", to: "@x/core", kind: "manifest" }];
const entryPoints: EntryPoint[] = [{ scope: "@x/app", main: "./src/main.ts", bin: [] }];
const tests: TestEntry[] = [
  { path: "packages/core/src/a.test.ts", scope: "@x/core", matchedBy: "**/*.test.*" },
];
const ownership: OwnershipRule[] = [{ pattern: "*", owners: ["@maint"] }];
const conventions: ConventionEntry[] = [
  { path: "biome.json", digest: sha256Hex("{biome}"), kind: "formatter" },
];

const symbolShards: SymbolShard[] = [
  {
    blobOid: B_A,
    extractor: "structural-ts-v1",
    symbols: [
      { name: "foo", kind: "function", line: 1 },
      { name: "Bar", kind: "class", line: 5 },
    ],
  },
  {
    blobOid: B_MAIN,
    extractor: "structural-ts-v1",
    symbols: [{ name: "main", kind: "function", line: 1 }],
  },
];

const inputs: SnapshotStructuralInputs = {
  repoKey: "/repo/.git",
  baseRef: "main",
  baseRefResolution: "symbolic-head" as BaseRefResolution,
  baseOid: "oid-base",
  files,
  scopes,
  edges,
  entryPoints,
  tests,
  ownership,
  conventions,
};

function loaded(): LoadedSnapshot {
  const built = buildSnapshot(inputs, symbolShards);
  const load: ShardLoader = (digest) => built.shards.get(digest);
  const result = materializeSnapshot(built.manifest, load);
  if (!result.ok) throw new Error(`materialize failed: ${result.slots.join(",")}`);
  return result.snapshot;
}

function patchFile(over: Partial<PatchFile> & Pick<PatchFile, "path" | "status">): PatchFile {
  return {
    previousPath: undefined,
    additions: 1,
    deletions: 0,
    binary: false,
    patch: "",
    ...over,
  };
}

function patchset(pfiles: PatchFile[]): Patchset {
  return {
    id: "patchset-1",
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: {
      id: "repo-1",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid: "oid-base",
      headOid: "oid-head",
    },
    files: pfiles,
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

/** Find the single entry for a (path, kind[, symbol]) triple. */
function entryFor(
  entries: readonly LedgerEntry[],
  path: string,
  kind: "file" | "symbol",
  symbol?: string,
): LedgerEntry {
  const found = entries.filter(
    (e) => e.unit.path === path && e.unit.kind === kind && e.unit.symbol === symbol,
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one ${kind} entry for ${path}${symbol ? `#${symbol}` : ""}, got ${found.length}`,
    );
  }
  return found[0] as LedgerEntry;
}

// ── Pure diff helpers ─────────────────────────────────────────────────────────

describe("parseAddedLines", () => {
  it("keeps only single-plus added lines and strips the marker", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " context",
      "-gone",
      "+added one",
      "+++ b/x",
      "+added two",
    ].join("\n");
    expect(parseAddedLines(patch)).toEqual(["added one", "added two"]);
  });
});

describe("patchIsTruncated", () => {
  it("detects the truncation marker", () => {
    expect(patchIsTruncated(`+x\n${DIFF_TRUNCATION_MARKER}\n`)).toBe(true);
    expect(patchIsTruncated("+x\n")).toBe(false);
  });
});

describe("introducedExports", () => {
  it("extracts exported declarations from added lines, deduped by name", () => {
    const added = ["export function baz() {}", "export const q = 1", "export function baz() {}"];
    expect(introducedExports("packages/core/src/a.ts", added).map((s) => s.name)).toEqual([
      "baz",
      "q",
    ]);
  });
  it("returns nothing for a non-source path", () => {
    expect(introducedExports("README.md", ["export const q = 1"])).toEqual([]);
  });
});

describe("classifyTestGlob", () => {
  it("maps test filenames and test directories to the recorded convention glob", () => {
    expect(classifyTestGlob("packages/core/src/x.test.ts")).toBe("**/*.test.*");
    expect(classifyTestGlob("packages/core/src/x.spec.tsx")).toBe("**/*.spec.*");
    expect(classifyTestGlob("packages/core/__tests__/x.ts")).toBe("**/__tests__/**");
    expect(classifyTestGlob("packages/core/tests/x.ts")).toBe("**/tests/**");
    expect(classifyTestGlob("packages/core/src/x.ts")).toBeNull();
  });
});

describe("scopeForPath", () => {
  it("returns the most specific scope, or null outside all scopes", () => {
    expect(scopeForPath(scopes, "packages/core/src/a.ts")).toBe("@x/core");
    expect(scopeForPath(scopes, "packages/app/src/main.ts")).toBe("@x/app");
    expect(scopeForPath(scopes, "README.md")).toBeNull();
  });
});

// ── The classifier ────────────────────────────────────────────────────────────

describe("classifyNovelty — files", () => {
  it("classifies a modified existing file as extends, citing the baseline blob", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([patchFile({ path: "packages/core/src/a.ts", status: "modified" })]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/a.ts", "file");
    expect(entry.classification).toBe("extends");
    expect(entry.evidence.shard).toBe("files");
    expect(entry.evidence.match).toEqual({
      kind: "file-present",
      path: "packages/core/src/a.ts",
      blobOid: B_A,
    });
    expect(entry.evidence.snapshotFingerprint).toBe(ledger.snapshotFingerprint);
    expect(entry.evidence.context.scope).toBe("@x/core");
  });

  it("classifies a brand-new source file as novel with a file-absent match", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([patchFile({ path: "packages/core/src/brand.ts", status: "added" })]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/brand.ts", "file");
    expect(entry.classification).toBe("novel");
    expect(entry.evidence.shard).toBeNull();
    expect(entry.evidence.match).toEqual({
      kind: "file-absent",
      path: "packages/core/src/brand.ts",
    });
  });

  it("classifies a new test file as conforms when the convention is already established", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([patchFile({ path: "packages/core/src/b.test.ts", status: "added" })]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/b.test.ts", "file");
    expect(entry.classification).toBe("conforms");
    expect(entry.evidence.shard).toBe("tests");
    expect(entry.evidence.match).toEqual({
      kind: "test-convention",
      path: "packages/core/src/b.test.ts",
      matchedBy: "**/*.test.*",
      siblingTestCount: 1,
    });
  });

  it("classifies a new test under an UNestablished convention as novel (a scope's first spec)", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([patchFile({ path: "packages/core/src/c.spec.ts", status: "added" })]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/c.spec.ts", "file");
    // No baseline test matched "**/*.spec.*", so there is no established convention to conform to.
    expect(entry.classification).toBe("novel");
    expect(entry.evidence.match.kind).toBe("file-absent");
  });

  it("classifies a rename off an existing baseline path as extends (file-renamed)", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({
          path: "packages/app/src/entry.ts",
          previousPath: "packages/app/src/main.ts",
          status: "renamed",
        }),
      ]),
    );
    const entry = entryFor(ledger.entries, "packages/app/src/entry.ts", "file");
    expect(entry.classification).toBe("extends");
    expect(entry.evidence.match).toEqual({
      kind: "file-renamed",
      from: "packages/app/src/main.ts",
      to: "packages/app/src/entry.ts",
      fromBlobOid: B_MAIN,
    });
    expect(entry.unit.previousPath).toBe("packages/app/src/main.ts");
  });

  it("classifies a deletion of an existing baseline file as extends (file-removed), no symbol units", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([patchFile({ path: "packages/core/src/a.ts", status: "deleted" })]),
    );
    expect(ledger.entries).toHaveLength(1);
    const entry = entryFor(ledger.entries, "packages/core/src/a.ts", "file");
    expect(entry.classification).toBe("extends");
    expect(entry.evidence.match).toEqual({
      kind: "file-removed",
      path: "packages/core/src/a.ts",
      blobOid: B_A,
    });
  });

  it("falls back to novel when a modified file is absent from the baseline (no entity to cite)", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([patchFile({ path: "packages/core/src/ghost.ts", status: "modified" })]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/ghost.ts", "file");
    expect(entry.classification).toBe("novel");
    expect(entry.evidence.match).toEqual({
      kind: "file-absent",
      path: "packages/core/src/ghost.ts",
    });
  });

  it("marks a truncated patch in the file context (partial symbol coverage)", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({
          path: "packages/core/src/a.ts",
          status: "modified",
          patch: `+export const seen = 1\n${DIFF_TRUNCATION_MARKER}\n`,
        }),
      ]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/a.ts", "file");
    expect(entry.evidence.context.patchTruncated).toBe(true);
    expect(entry.evidence.context.isKnownTest).toBe(false);
  });

  it("flags a modified known test / convention file in its context", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({ path: "packages/core/src/a.test.ts", status: "modified" }),
        patchFile({ path: "biome.json", status: "modified" }),
      ]),
    );
    expect(
      entryFor(ledger.entries, "packages/core/src/a.test.ts", "file").evidence.context.isKnownTest,
    ).toBe(true);
    expect(entryFor(ledger.entries, "biome.json", "file").evidence.context.isConvention).toBe(true);
  });
});

describe("classifyNovelty — symbols", () => {
  it("classifies an introduced export absent from the baseline file as a novel symbol", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({
          path: "packages/core/src/a.ts",
          status: "modified",
          patch: ["@@ -1 +1,2 @@", "+export function baz() {}"].join("\n"),
        }),
      ]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/a.ts", "symbol", "baz");
    expect(entry.classification).toBe("novel");
    expect(entry.evidence.shard).toBeNull();
    expect(entry.evidence.match).toEqual({
      kind: "symbol-absent",
      path: "packages/core/src/a.ts",
      symbol: "baz",
    });
  });

  it("classifies an introduced export that already exists in the baseline file as extends", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({
          path: "packages/core/src/a.ts",
          status: "modified",
          patch: ["@@ -1 +1,2 @@", "+export function foo() {}"].join("\n"),
        }),
      ]),
    );
    const entry = entryFor(ledger.entries, "packages/core/src/a.ts", "symbol", "foo");
    expect(entry.classification).toBe("extends");
    expect(entry.evidence.shard).toBe("symbols");
    expect(entry.evidence.match).toEqual({
      kind: "symbol-present",
      path: "packages/core/src/a.ts",
      symbol: { name: "foo", kind: "function", line: 1 },
      blobOid: B_A,
    });
  });

  it("treats every introduced export in a brand-new file as novel", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({
          path: "packages/core/src/brand.ts",
          status: "added",
          patch: ["+export const glass = 1", "+export function shape() {}"].join("\n"),
        }),
      ]),
    );
    expect(
      entryFor(ledger.entries, "packages/core/src/brand.ts", "symbol", "glass").classification,
    ).toBe("novel");
    expect(
      entryFor(ledger.entries, "packages/core/src/brand.ts", "symbol", "shape").classification,
    ).toBe("novel");
  });
});

describe("classifyNovelty — determinism & pinning", () => {
  it("is byte-stable and pins to the snapshot fingerprint + patchset id", () => {
    const snapshot = loaded();
    const ps = patchset([
      patchFile({
        path: "packages/core/src/a.ts",
        status: "modified",
        patch: ["+export function baz() {}", "+export function foo() {}"].join("\n"),
      }),
      patchFile({ path: "packages/core/src/b.test.ts", status: "added" }),
    ]);
    const one = classifyNovelty(snapshot, ps);
    const two = classifyNovelty(snapshot, ps);
    expect(one).toEqual(two);
    expect(one.baseOid).toBe("oid-base");
    expect(one.patchsetId).toBe("patchset-1");
    expect(one.snapshotFingerprint).toBe(snapshot.manifest.fingerprint);
  });

  it("emits entries in a total, path-then-kind-then-symbol order", () => {
    const ledger = classifyNovelty(
      loaded(),
      patchset([
        patchFile({
          path: "packages/core/src/z.ts",
          status: "added",
          patch: "+export const zz = 1",
        }),
        patchFile({
          path: "packages/core/src/a.ts",
          status: "modified",
          patch: ["+export function baz() {}", "+export function aaa() {}"].join("\n"),
        }),
      ]),
    );
    const keys = ledger.entries.map((e) => `${e.unit.path}|${e.unit.kind}|${e.unit.symbol ?? ""}`);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    // a.ts file entry precedes its symbol entries; aaa precedes baz.
    expect(keys[0]).toBe("packages/core/src/a.ts|file|");
    expect(keys[1]).toBe("packages/core/src/a.ts|symbol|aaa");
    expect(keys[2]).toBe("packages/core/src/a.ts|symbol|baz");
  });
});
