import { sha256Hex } from "@rennet/protocol";
import type {
  BaseRefResolution,
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  OwnershipRule,
  ProjectSnapshotManifest,
  SnapshotFileEntry,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { LoadedSnapshot, ShardLoader } from "./project-context";
import {
  isSafeRepoRelativePath,
  materializeSnapshot,
  queryFileContext,
  queryProjectMap,
} from "./project-context";
import { buildSnapshot, type SnapshotStructuralInputs } from "./project-snapshot";

// ── A small, coherent fixture snapshot, built through the real builder ─────────
//
// Two blobs are SHARED across paths (a copy) so the `path → blobOid → symbol
// shard` join is exercised for a blob referenced by two paths. A symlink and a
// non-source file both lack a symbol shard, to exercise the legitimate
// "no symbols" answer distinct from a missing shard.

const B_A = "blob-a";
const B_M = "blob-m";
const B_JSON = "blob-json";
const B_LINK = "blob-link";
const B_TEST = "blob-test";

const files: SnapshotFileEntry[] = [
  { path: "packages/core/src/a.ts", blobOid: B_A, size: 30, mode: "100644" },
  { path: "packages/core/src/copy-of-a.ts", blobOid: B_A, size: 30, mode: "100644" },
  { path: "packages/core/src/a.test.ts", blobOid: B_TEST, size: 10, mode: "100644" },
  { path: "packages/core/src/link.ts", blobOid: B_LINK, size: 12, mode: "120000" },
  { path: "packages/core/package.json", blobOid: B_JSON, size: 40, mode: "100644" },
  { path: "packages/app/src/main.ts", blobOid: B_M, size: 20, mode: "100644" },
];

const scopes: WorkspaceScope[] = [
  {
    name: "@x/core",
    root: "packages/core",
    sourceRoot: "packages/core/src",
    type: "library",
    private: true,
    tags: [],
  },
  {
    name: "@x/app",
    root: "packages/app",
    sourceRoot: "packages/app/src",
    type: "application",
    private: true,
    tags: [],
  },
];

const edges: DependencyEdge[] = [{ from: "@x/app", to: "@x/core", kind: "manifest" }];
const entryPoints: EntryPoint[] = [
  { scope: "@x/core", main: "./src/index.ts", bin: [] },
  { scope: "@x/app", main: "./src/main.ts", bin: [] },
];
const tests: TestEntry[] = [
  { path: "packages/core/src/a.test.ts", scope: "@x/core", matchedBy: "*.test.ts" },
];
const ownership: OwnershipRule[] = [
  { pattern: "*", owners: ["@maint"] },
  { pattern: "packages/core/**", owners: ["@core"] },
];
const conventions: ConventionEntry[] = [
  { path: "biome.json", digest: sha256Hex("{biome}"), kind: "formatter" },
  { path: "packages/core/tsconfig.json", digest: sha256Hex("{ts}"), kind: "typescript" },
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
    blobOid: B_M,
    extractor: "structural-ts-v1",
    symbols: [{ name: "main", kind: "function", line: 1 }],
  },
];

const inputs: SnapshotStructuralInputs = {
  repoKey: "/repo/.git",
  baseRef: "main",
  baseRefResolution: "symbolic-head" as BaseRefResolution,
  baseOid: "oid-abc",
  files,
  scopes,
  edges,
  entryPoints,
  tests,
  ownership,
  conventions,
};

function build(): { manifest: ProjectSnapshotManifest; load: ShardLoader } {
  const built = buildSnapshot(inputs, symbolShards);
  return { manifest: built.manifest, load: (digest) => built.shards.get(digest) };
}

function loaded(): LoadedSnapshot {
  const { manifest, load } = build();
  const result = materializeSnapshot(manifest, load);
  if (!result.ok) throw new Error(`materialize failed: ${result.slots.join(",")}`);
  return result.snapshot;
}

describe("isSafeRepoRelativePath", () => {
  it("accepts clean repo-relative POSIX paths", () => {
    expect(isSafeRepoRelativePath("packages/core/src/a.ts")).toBe(true);
    expect(isSafeRepoRelativePath("a.ts")).toBe(true);
  });

  it("refuses absolute, traversal, dot, empty, double-slash, and backslash paths", () => {
    expect(isSafeRepoRelativePath("")).toBe(false);
    expect(isSafeRepoRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRepoRelativePath("../secret")).toBe(false);
    expect(isSafeRepoRelativePath("packages/../etc")).toBe(false);
    expect(isSafeRepoRelativePath("./a.ts")).toBe(false);
    expect(isSafeRepoRelativePath("a//b.ts")).toBe(false);
    expect(isSafeRepoRelativePath("a/b/")).toBe(false);
    expect(isSafeRepoRelativePath("a\\b.ts")).toBe(false);
  });
});

describe("materializeSnapshot", () => {
  it("decodes every structural shard and indexes symbol digests by blob", () => {
    const snapshot = loaded();
    expect(snapshot.files).toHaveLength(files.length);
    expect(snapshot.scopes.map((s) => s.name)).toEqual(["@x/app", "@x/core"]);
    expect(snapshot.symbolDigestByBlob.has(B_A)).toBe(true);
    expect(snapshot.symbolDigestByBlob.has(B_M)).toBe(true);
    // No symbol shard was passed for the .json, symlink, or test blob.
    expect(snapshot.symbolDigestByBlob.has(B_JSON)).toBe(false);
    expect(snapshot.symbolDigestByBlob.has(B_LINK)).toBe(false);
    expect(snapshot.symbolDigestByBlob.has(B_TEST)).toBe(false);
  });

  it("fails closed (naming the slot) when a structural shard is absent", () => {
    const { manifest, load } = build();
    const filesDigest = manifest.shards.files.digest;
    const holed: ShardLoader = (digest) => (digest === filesDigest ? undefined : load(digest));
    const result = materializeSnapshot(manifest, holed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.slots).toContain("files");
  });

  it("fails closed when a structural shard's bytes do not hash to its digest", () => {
    const { manifest, load } = build();
    const scopesDigest = manifest.shards.scopes.digest;
    const tampered: ShardLoader = (digest) =>
      digest === scopesDigest ? '{"slot":"scopes","version":1,"entries":[]}' : load(digest);
    const result = materializeSnapshot(manifest, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.slots).toContain("scopes");
  });
});

describe("queryProjectMap", () => {
  it("returns the whole map with the base-ref pin when unscoped", () => {
    const map = queryProjectMap(loaded());
    expect(map.baseRef).toBe("main");
    expect(map.baseOid).toBe("oid-abc");
    expect(map.baseRefResolution).toBe("symbolic-head");
    expect(map.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(map.files).toHaveLength(files.length);
    expect(map.scopes).toHaveLength(2);
    expect(map.edges).toHaveLength(1);
    expect(map.entryPoints).toHaveLength(2);
    expect(map.tests).toHaveLength(1);
    expect(map.ownership).toHaveLength(2);
    expect(map.conventions).toHaveLength(2);
  });

  it("is deterministic: same snapshot yields a deep-equal map", () => {
    expect(queryProjectMap(loaded())).toEqual(queryProjectMap(loaded()));
  });

  it("scopes to a path subtree", () => {
    const map = queryProjectMap(loaded(), { path: "packages/core" });
    expect(map.files.map((f) => f.path)).toEqual([
      "packages/core/package.json",
      "packages/core/src/a.test.ts",
      "packages/core/src/a.ts",
      "packages/core/src/copy-of-a.ts",
      "packages/core/src/link.ts",
    ]);
    expect(map.scopes.map((s) => s.name)).toEqual(["@x/core"]);
    // The edge's `@x/app` endpoint is outside the subtree, so it is dropped.
    expect(map.edges).toHaveLength(0);
    expect(map.entryPoints.map((e) => e.scope)).toEqual(["@x/core"]);
    expect(map.tests).toHaveLength(1);
    // biome.json (repo root) is out; packages/core/tsconfig.json is in.
    expect(map.conventions.map((c) => c.path)).toEqual(["packages/core/tsconfig.json"]);
    // "*" catch-all and "packages/core/**" both apply to this subtree.
    expect(map.ownership.map((o) => o.pattern)).toEqual(["*", "packages/core/**"]);
  });

  it("scopes to a named workspace scope", () => {
    const map = queryProjectMap(loaded(), { scope: "@x/app" });
    expect(map.files.map((f) => f.path)).toEqual(["packages/app/src/main.ts"]);
    expect(map.scopes.map((s) => s.name)).toEqual(["@x/app"]);
    expect(map.entryPoints.map((e) => e.scope)).toEqual(["@x/app"]);
    expect(map.tests).toHaveLength(0);
    expect(map.conventions).toHaveLength(0);
    // Only the catch-all ownership rule reaches packages/app.
    expect(map.ownership.map((o) => o.pattern)).toEqual(["*"]);
  });

  it("returns an empty map for an unknown scope name", () => {
    const map = queryProjectMap(loaded(), { scope: "@x/nope" });
    expect(map.files).toHaveLength(0);
    expect(map.scopes).toHaveLength(0);
    expect(map.edges).toHaveLength(0);
    expect(map.entryPoints).toHaveLength(0);
  });
});

describe("queryFileContext", () => {
  it("recovers a file's structural entry and symbols via path → blobOid → shard", () => {
    const result = queryFileContext(loaded(), "packages/core/src/a.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.blobOid).toBe(B_A);
    expect(result.context.scope).toBe("@x/core");
    expect(result.context.isSymlink).toBe(false);
    expect(result.context.hasSymbols).toBe(true);
    expect(result.context.extractor).toBe("structural-ts-v1");
    expect(result.context.symbols.map((s) => s.name)).toEqual(["foo", "Bar"]);
    expect(result.context.tests).toHaveLength(0);
  });

  it("resolves the SAME symbols for a copied blob at a different path", () => {
    const a = queryFileContext(loaded(), "packages/core/src/a.ts");
    const copy = queryFileContext(loaded(), "packages/core/src/copy-of-a.ts");
    expect(a.ok && copy.ok).toBe(true);
    if (!a.ok || !copy.ok) return;
    expect(copy.context.blobOid).toBe(a.context.blobOid);
    expect(copy.context.symbols).toEqual(a.context.symbols);
  });

  it("reports a test file's inventory entry", () => {
    const result = queryFileContext(loaded(), "packages/core/src/a.test.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tests).toHaveLength(1);
    expect(result.context.hasSymbols).toBe(false);
    expect(result.context.symbols).toHaveLength(0);
  });

  it("returns a legitimate no-symbols answer for a symlink and a non-source file", () => {
    const link = queryFileContext(loaded(), "packages/core/src/link.ts");
    const json = queryFileContext(loaded(), "packages/core/package.json");
    expect(link.ok && json.ok).toBe(true);
    if (!link.ok || !json.ok) return;
    expect(link.context.isSymlink).toBe(true);
    expect(link.context.hasSymbols).toBe(false);
    expect(link.context.symbols).toHaveLength(0);
    expect(json.context.isSymlink).toBe(false);
    expect(json.context.hasSymbols).toBe(false);
  });

  it("refuses an unsafe path", () => {
    const result = queryFileContext(loaded(), "../etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-path");
  });

  it("reports not-found for a path absent from the tree", () => {
    const result = queryFileContext(loaded(), "packages/core/src/ghost.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });

  it("fails closed when a referenced symbol shard cannot be produced", () => {
    const { manifest, load } = build();
    const materialized = materializeSnapshot(manifest, load);
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    // Hole out the symbol shard for B_A specifically.
    const aDigest = materialized.snapshot.symbolDigestByBlob.get(B_A);
    const holed: LoadedSnapshot = {
      ...materialized.snapshot,
      load: (digest) => (digest === aDigest ? undefined : load(digest)),
    };
    const result = queryFileContext(holed, "packages/core/src/a.ts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("shard-unavailable");
  });
});
