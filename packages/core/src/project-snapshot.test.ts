import type {
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  OwnershipRule,
  SnapshotFileEntry,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  computeFingerprint,
  DEFAULT_SYMBOL_EXTRACTOR_ID,
  eligibleSymbolFiles,
  extractSymbolShard,
  indexReferenceShards,
  indexSymbolShards,
  isSnapshotFresh,
  planIncrementalReferences,
  planIncrementalSymbols,
  type SnapshotStructuralInputs,
  serializeManifest,
  structuralReferenceExtractor,
  structuralTsExtractor,
  verifySnapshotIntegrity,
} from "./project-snapshot";

// ── A tiny deterministic "tree": path → content, at two OIDs ──────────────────
//
// A fake tree lets the property test exercise the whole machinery WITHOUT git,
// nx, or the disk. The fake blob OID is a content hash, exactly as git's is a
// pure function of bytes: same content ⇒ same blobOid ⇒ reusable symbol shard.

type Tree = Map<string, string>;

function blobOid(text: string): string {
  return `blob-${sha256Hex(text)}`;
}

function filesOf(tree: Tree): SnapshotFileEntry[] {
  return [...tree.entries()].map(([path, text]) => ({
    path,
    blobOid: blobOid(text),
    size: Buffer.byteLength(text),
    mode: "100644",
  }));
}

function testsOf(tree: Tree): TestEntry[] {
  const out: TestEntry[] = [];
  for (const path of tree.keys()) {
    if (path.endsWith(".test.ts") || path.endsWith(".spec.ts")) {
      out.push({ path, scope: null, matchedBy: "*.{test,spec}.ts" });
    }
  }
  return out;
}

const scopes: WorkspaceScope[] = [
  {
    name: "@x/core",
    root: "packages/core",
    sourceRoot: "packages/core/src",
    type: "library",
    private: true,
    tags: ["scope:x"],
  },
  {
    name: "@x/app",
    root: "apps/app",
    sourceRoot: "apps/app/src",
    type: "application",
    private: true,
    tags: ["scope:x"],
  },
];
const edges: DependencyEdge[] = [{ from: "@x/app", to: "@x/core", kind: "manifest" }];
const entryPoints: EntryPoint[] = [
  { scope: "@x/core", main: "./src/index.ts", bin: [] },
  { scope: "@x/app", main: "./src/main.ts", bin: [["app", "./bin/app.js"]] },
];
const ownership: OwnershipRule[] = [
  { pattern: "*", owners: ["@x/maintainers"] },
  { pattern: "packages/core/**", owners: ["@x/core-team"] },
];
const conventions: ConventionEntry[] = [
  { path: "biome.json", digest: sha256Hex("{biome}"), kind: "formatter" },
  { path: "tsconfig.base.json", digest: sha256Hex("{ts}"), kind: "typescript" },
];

function inputsFor(baseOid: string, tree: Tree): SnapshotStructuralInputs {
  return {
    repoKey: "/real/path/.git",
    baseRef: "origin/main",
    baseRefResolution: "symbolic-head",
    baseOid,
    files: filesOf(tree),
    scopes,
    edges,
    entryPoints,
    tests: testsOf(tree),
    ownership,
    conventions,
  };
}

/** A full build: extract symbols for every eligible file. */
function fullBuild(baseOid: string, tree: Tree) {
  const inputs = inputsFor(baseOid, tree);
  const symbolShards = eligibleSymbolFiles(inputs.files).map((file) =>
    extractSymbolShard(file, tree.get(file.path) ?? ""),
  );
  return buildSnapshot(inputs, symbolShards);
}

/** An incremental build: reuse unchanged blobs from a previous build, extract the closure. */
function incrementalBuild(baseOid: string, tree: Tree, previous: readonly SymbolShard[]) {
  const inputs = inputsFor(baseOid, tree);
  const eligible = eligibleSymbolFiles(inputs.files);
  const plan = planIncrementalSymbols(
    eligible,
    indexSymbolShards(previous),
    DEFAULT_SYMBOL_EXTRACTOR_ID,
  );
  const extracted = plan.toExtract.map((file) =>
    extractSymbolShard(file, tree.get(file.path) ?? ""),
  );
  return { built: buildSnapshot(inputs, [...plan.reuse, ...extracted]), plan };
}

function symbolShardsOf(baseOid: string, tree: Tree): SymbolShard[] {
  const inputs = inputsFor(baseOid, tree);
  return eligibleSymbolFiles(inputs.files).map((file) =>
    extractSymbolShard(file, tree.get(file.path) ?? ""),
  );
}

const treeV1: Tree = new Map([
  ["packages/core/src/index.ts", "export const a = 1;\nexport function make() {}\n"],
  ["packages/core/src/util.ts", "export type T = number;\nexport class Helper {}\n"],
  ["packages/core/src/index.test.ts", "import { a } from './index';\n"],
  ["apps/app/src/main.ts", "export default function main() {}\n"],
  ["README.md", "# x\n"],
]);

// V2: change ONE file (util.ts), add a new file, leave the rest byte-identical.
const treeV2: Tree = new Map([
  ["packages/core/src/index.ts", "export const a = 1;\nexport function make() {}\n"],
  [
    "packages/core/src/util.ts",
    "export type T = string;\nexport class Helper {}\nexport const NEW = 2;\n",
  ],
  ["packages/core/src/index.test.ts", "import { a } from './index';\n"],
  ["packages/core/src/added.ts", "export const added = true;\n"],
  ["apps/app/src/main.ts", "export default function main() {}\n"],
  ["README.md", "# x\n"],
]);

describe("buildSnapshot — determinism", () => {
  it("is byte-identical across two full builds of the same tree", () => {
    const a = fullBuild("oid1", treeV1);
    const b = fullBuild("oid1", treeV1);
    expect(serializeManifest(a.manifest)).toBe(serializeManifest(b.manifest));
    expect([...a.shards].sort()).toEqual([...b.shards].sort());
  });

  it("does not depend on the order files/scopes/edges were discovered in", () => {
    const inputs = inputsFor("oid1", treeV1);
    const shuffled: SnapshotStructuralInputs = {
      ...inputs,
      files: [...inputs.files].reverse(),
      scopes: [...inputs.scopes].reverse(),
      edges: [...inputs.edges].reverse(),
      entryPoints: [...inputs.entryPoints].reverse(),
      tests: [...inputs.tests].reverse(),
      conventions: [...inputs.conventions].reverse(),
    };
    const straight = buildSnapshot(inputs, symbolShardsOf("oid1", treeV1));
    const jumbled = buildSnapshot(shuffled, [...symbolShardsOf("oid1", treeV1)].reverse());
    expect(serializeManifest(jumbled.manifest)).toBe(serializeManifest(straight.manifest));
  });

  it("serialized bytes contain no timestamp/clock field", () => {
    const { manifest } = fullBuild("oid1", treeV1);
    const bytes = serializeManifest(manifest);
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no ISO timestamp
    expect(JSON.parse(bytes)).not.toHaveProperty("builtAt");
    expect(JSON.parse(bytes)).not.toHaveProperty("createdAt");
  });
});

describe("the load-bearing property: incremental === clean full build, byte-for-byte", () => {
  it("produces a byte-identical manifest and shard set", () => {
    const clean = fullBuild("oid2", treeV2);
    const previous = symbolShardsOf("oid1", treeV1);
    const { built: incremental, plan } = incrementalBuild("oid2", treeV2, previous);

    // Sanity: the incremental build genuinely reused work and only re-extracted
    // the changed closure (util.ts changed; added.ts is new). index.ts + main.ts
    // are byte-identical blobs, so they are reused, not re-extracted.
    const extractedPaths = plan.toExtract.map((f) => f.path).sort();
    expect(extractedPaths).toEqual(["packages/core/src/added.ts", "packages/core/src/util.ts"]);
    expect(plan.reuse.length).toBeGreaterThan(0);

    // The property.
    expect(serializeManifest(incremental.manifest)).toBe(serializeManifest(clean.manifest));
    expect(incremental.manifest.fingerprint).toBe(clean.manifest.fingerprint);

    const cleanShards = new Map(clean.shards);
    const incShards = new Map(incremental.shards);
    expect([...incShards.keys()].sort()).toEqual([...cleanShards.keys()].sort());
    for (const [digest, bytes] of incShards) {
      expect(bytes).toBe(cleanShards.get(digest));
    }
  });

  it("holds even when every file changed (empty reuse set)", () => {
    const previous = symbolShardsOf("oid1", treeV1);
    // A tree that shares no blob with V1.
    const treeV3: Tree = new Map([
      ["packages/core/src/index.ts", "export const z = 99;\n"],
      ["apps/app/src/main.ts", "export default 0;\n"],
    ]);
    const clean = fullBuild("oid3", treeV3);
    const { built: incremental, plan } = incrementalBuild("oid3", treeV3, previous);
    expect(plan.reuse).toHaveLength(0);
    expect(serializeManifest(incremental.manifest)).toBe(serializeManifest(clean.manifest));
  });
});

describe("rename & same-content copy: incremental === clean, byte-for-byte (the review's blocker)", () => {
  // CONTROLLED inputs on purpose. rennet's own git history contains NO
  // eligible-source (.ts/.js) rename or same-content copy — only a single `.md`
  // rename and some config/yaml/json copies, none of which produce symbol shards
  // — so the bug cannot be reproduced from real history; a same-content pair of
  // SOURCE files is required. Against the pre-fix code (path baked into the
  // symbol-shard bytes) BOTH tests FAIL; after removing path from the shard bytes
  // they PASS. Proven red-before / green-after.

  it("a pure RENAME (same blob, new path) yields byte-identical incremental and clean builds", () => {
    const v1: Tree = new Map([
      ["src/mod-a.ts", "export const shared = 1;\nexport function f() {}\n"],
      ["src/keep.ts", "export const keep = 0;\n"],
    ]);
    // mod-a.ts → mod-b.ts, byte-identical content; keep.ts untouched.
    const v2: Tree = new Map([
      ["src/mod-b.ts", "export const shared = 1;\nexport function f() {}\n"],
      ["src/keep.ts", "export const keep = 0;\n"],
    ]);

    const previous = symbolShardsOf("oid1", v1);
    const clean = fullBuild("oid2", v2);
    const { built: incremental, plan } = incrementalBuild("oid2", v2, previous);

    // Nothing changed content, so the renamed blob is reused verbatim — any
    // divergence here is PURELY the path-in-shard bug.
    expect(plan.toExtract).toHaveLength(0);
    expect(plan.reuse).toHaveLength(2);

    expect(serializeManifest(incremental.manifest)).toBe(serializeManifest(clean.manifest));
    expect(incremental.manifest.fingerprint).toBe(clean.manifest.fingerprint);

    const cleanShards = new Map(clean.shards);
    const incShards = new Map(incremental.shards);
    expect([...incShards.keys()].sort()).toEqual([...cleanShards.keys()].sort());
    for (const [digest, bytes] of incShards) expect(bytes).toBe(cleanShards.get(digest));
  });

  it("a same-content COPY (two paths, one blob) yields byte-identical incremental and clean builds", () => {
    // v1 holds the blob at a path that sorts LATE; v2 adds a copy at a path that
    // sorts EARLY and keeps the original. A clean build's blobOid dedup keeps the
    // FIRST-encountered path's shard (a-copy); the incremental build reuses the
    // PRIOR shard (z-orig). With path in the shard bytes those two disagree; with
    // path out of the bytes they are the same shard. This is the copy divergence
    // the review flagged (worse than rename: the retained path is arbitrary).
    const v1: Tree = new Map([
      ["src/z-orig.ts", "export const dup = 2;\n"],
      ["src/keep.ts", "export const keep = 0;\n"],
    ]);
    const v2: Tree = new Map([
      ["src/a-copy.ts", "export const dup = 2;\n"],
      ["src/z-orig.ts", "export const dup = 2;\n"],
      ["src/keep.ts", "export const keep = 0;\n"],
    ]);

    const previous = symbolShardsOf("oid1", v1);
    const clean = fullBuild("oid2", v2);
    const { built: incremental } = incrementalBuild("oid2", v2, previous);

    // One blob shared by two paths ⇒ exactly one symbol entry for it; two
    // distinct blobs total (dup + keep) ⇒ two symbol entries in each build.
    expect(clean.manifest.symbols).toHaveLength(2);
    expect(incremental.manifest.symbols).toHaveLength(2);

    expect(serializeManifest(incremental.manifest)).toBe(serializeManifest(clean.manifest));
    expect(incremental.manifest.fingerprint).toBe(clean.manifest.fingerprint);

    const cleanShards = new Map(clean.shards);
    const incShards = new Map(incremental.shards);
    expect([...incShards.keys()].sort()).toEqual([...cleanShards.keys()].sort());
    for (const [digest, bytes] of incShards) expect(bytes).toBe(cleanShards.get(digest));
  });
});

describe("the staleness gate: a stale or corrupt shard cannot be served", () => {
  it("is fresh only at the exact pinned OID", () => {
    const { manifest } = fullBuild("oid2", treeV2);
    expect(isSnapshotFresh(manifest, "oid2")).toBe(true);
    expect(isSnapshotFresh(manifest, "oid1")).toBe(false);
    expect(isSnapshotFresh(manifest, "")).toBe(false);
  });

  it("passes integrity when every referenced shard is present and intact", () => {
    const { manifest, shards } = fullBuild("oid2", treeV2);
    const result = verifySnapshotIntegrity(manifest, (d) => shards.get(d));
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.mismatched).toHaveLength(0);
  });

  it("fails closed when a referenced shard is missing", () => {
    const { manifest, shards } = fullBuild("oid2", treeV2);
    const missingDigest = manifest.shards.files.digest;
    const result = verifySnapshotIntegrity(manifest, (d) =>
      d === missingDigest ? undefined : shards.get(d),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(missingDigest);
  });

  it("fails closed when a stored shard's bytes are corrupted", () => {
    const { manifest, shards } = fullBuild("oid2", treeV2);
    const target = manifest.shards.scopes.digest;
    const result = verifySnapshotIntegrity(manifest, (d) =>
      d === target ? `${shards.get(d)} tampered` : shards.get(d),
    );
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain(target);
  });

  it("fails closed when the manifest fingerprint is tampered", () => {
    const { manifest, shards } = fullBuild("oid2", treeV2);
    const tampered = { ...manifest, fingerprint: `${manifest.fingerprint}0` };
    const result = verifySnapshotIntegrity(tampered, (d) => shards.get(d));
    expect(result.ok).toBe(false);
  });

  it("fingerprint changes when any shard digest changes", () => {
    const a = fullBuild("oid1", treeV1).manifest;
    const b = fullBuild("oid1", treeV2).manifest; // same OID label, different content
    expect(a.fingerprint).not.toBe(b.fingerprint);
    // And it is a pure recomputation, not a stored value.
    expect(
      computeFingerprint(
        {
          repoKey: a.repoKey,
          baseRef: a.baseRef,
          baseRefResolution: a.baseRefResolution,
          baseOid: a.baseOid,
        },
        a.shards,
        a.symbols,
        a.references,
      ),
    ).toBe(a.fingerprint);
  });

  it("covers repoKey / baseRef / baseRefResolution (#4): a change to any of them changes the fingerprint", () => {
    // Two snapshots of the SAME tree at the SAME OID that differ ONLY in an
    // identifying manifest field must NOT share a fingerprint — the fingerprint
    // is meant to identify all canonical manifest content, not just the shards.
    const base = fullBuild("oid2", treeV2).manifest;

    const otherRepo = buildSnapshot(
      { ...inputsFor("oid2", treeV2), repoKey: "/some/other/repo/.git" },
      symbolShardsOf("oid2", treeV2),
    ).manifest;
    expect(otherRepo.fingerprint).not.toBe(base.fingerprint);

    const otherRef = buildSnapshot(
      { ...inputsFor("oid2", treeV2), baseRef: "origin/release" },
      symbolShardsOf("oid2", treeV2),
    ).manifest;
    expect(otherRef.fingerprint).not.toBe(base.fingerprint);

    const otherResolution = buildSnapshot(
      { ...inputsFor("oid2", treeV2), baseRefResolution: "explicit-setting" },
      symbolShardsOf("oid2", treeV2),
    ).manifest;
    expect(otherResolution.fingerprint).not.toBe(base.fingerprint);

    // Sanity: identical inputs still agree (the property that must survive #4).
    const twin = buildSnapshot(inputsFor("oid2", treeV2), symbolShardsOf("oid2", treeV2)).manifest;
    expect(twin.fingerprint).toBe(base.fingerprint);
  });
});

describe("structuralTsExtractor — deterministic, best-effort TS/JS exports", () => {
  it("extracts top-level declarations with kinds and lines", () => {
    const text = [
      "export const a = 1;",
      "export function fn() {}",
      "export async function afn() {}",
      "export class C {}",
      "export abstract class AC {}",
      "export interface I {}",
      "export type T = number;",
      "export enum E {}",
      "export const enum CE {}",
      "export let l = 2;",
      "export var v = 3;",
      "export default function main() {}",
    ].join("\n");
    const syms = structuralTsExtractor("f.ts", text);
    expect(syms.map((s) => [s.name, s.kind])).toEqual([
      ["a", "const"],
      ["fn", "function"],
      ["afn", "function"],
      ["C", "class"],
      ["AC", "class"],
      ["I", "interface"],
      ["T", "type"],
      ["E", "enum"],
      ["CE", "enum"],
      ["l", "let"],
      ["v", "var"],
      ["default", "default"],
    ]);
    expect(syms[0]?.line).toBe(1);
    expect(syms[11]?.line).toBe(12);
  });

  it("handles re-exports and star exports", () => {
    const text = [
      "export { A, B as C } from './x';",
      "export * from './y';",
      "export type { T } from './z';",
    ].join("\n");
    const syms = structuralTsExtractor("f.ts", text);
    expect(syms.map((s) => s.name)).toEqual(["A", "C", "*", "T"]);
    expect(syms.every((s) => s.kind === "reexport")).toBe(true);
  });

  it("skips block comments and non-export lines", () => {
    const text = [
      "/* export const hidden = 1; */",
      "const local = 2;",
      "export const shown = 3;",
    ].join("\n");
    expect(structuralTsExtractor("f.ts", text).map((s) => s.name)).toEqual(["shown"]);
  });

  it("does not match exportfoo (word boundary)", () => {
    expect(structuralTsExtractor("f.ts", "exportfoo();\n")).toHaveLength(0);
  });

  it("returns nothing for non-source files", () => {
    expect(structuralTsExtractor("README.md", "export const a = 1;")).toHaveLength(0);
  });

  it("is a pure function of bytes (same in ⇒ same out)", () => {
    const text = "export const a = 1;\nexport function b() {}\n";
    expect(structuralTsExtractor("f.ts", text)).toEqual(structuralTsExtractor("f.ts", text));
  });
});

describe("structuralReferenceExtractor — deterministic identifier occurrences", () => {
  it("records each identifier's 1-based lines, sorted and de-duplicated, keyed by name", () => {
    const text = ["const foo = makeThing();", "foo(foo);", "", "return foo;"].join("\n");
    const refs = structuralReferenceExtractor("f.ts", text);
    const byName = new Map(refs.map((r) => [r.name, r.lines]));
    // `foo`: declaration line 1, two uses on line 2 (de-duped to one), and line 4.
    expect(byName.get("foo")).toEqual([1, 2, 4]);
    expect(byName.get("makeThing")).toEqual([1]);
    // The whole list is sorted by name for stable, content-addressable bytes.
    expect(refs.map((r) => r.name)).toEqual([...refs.map((r) => r.name)].sort());
  });

  it("excludes language keywords and primitive-type words (stopwords)", () => {
    const names = structuralReferenceExtractor(
      "f.ts",
      "const x: string = returnValue;\nreturn x;\n",
    ).map((r) => r.name);
    // `const`, `string`, `return` are stopwords; `x` and `returnValue` are indexed.
    expect(names).toContain("x");
    expect(names).toContain("returnValue");
    expect(names).not.toContain("const");
    expect(names).not.toContain("string");
    expect(names).not.toContain("return");
  });

  it("skips block comments but (honestly) indexes line comments and strings", () => {
    const text = [
      "/* widget lives here */",
      "const s = 'widget';",
      "call(widget); // widget again",
    ].join("\n");
    const lines = new Map(
      structuralReferenceExtractor("f.ts", text).map((r) => [r.name, r.lines]),
    ).get("widget");
    // Block-comment occurrence on line 1 is skipped; the string literal (line 2) and
    // the code + line-comment (line 3) ARE recorded — the documented textual limit.
    expect(lines).toEqual([2, 3]);
  });

  it("returns nothing for non-source files", () => {
    expect(structuralReferenceExtractor("README.md", "foo bar baz")).toHaveLength(0);
  });

  it("is a pure function of bytes (same in ⇒ same out)", () => {
    const text = "const a = b + c;\nfn(a, b);\n";
    expect(structuralReferenceExtractor("f.ts", text)).toEqual(
      structuralReferenceExtractor("f.ts", text),
    );
  });
});

describe("planIncrementalReferences — reuse by blob, extract the changed closure", () => {
  it("reuses a shard for an unchanged blob and queues a new/changed blob for extraction", () => {
    const unchanged: SnapshotFileEntry = {
      path: "a.ts",
      blobOid: "blob-a",
      size: 1,
      mode: "100644",
    };
    const fresh: SnapshotFileEntry = { path: "b.ts", blobOid: "blob-b", size: 1, mode: "100644" };
    const previous = indexReferenceShards([
      {
        blobOid: "blob-a",
        extractor: "structural-refs-v1",
        references: [{ name: "x", lines: [1] }],
      },
    ]);
    const plan = planIncrementalReferences([unchanged, fresh], previous, "structural-refs-v1");
    expect(plan.reuse.map((s) => s.blobOid)).toEqual(["blob-a"]);
    expect(plan.toExtract.map((f) => f.blobOid)).toEqual(["blob-b"]);
  });

  it("re-extracts when the previous shard came from a different extractor id", () => {
    const file: SnapshotFileEntry = { path: "a.ts", blobOid: "blob-a", size: 1, mode: "100644" };
    const previous = indexReferenceShards([
      { blobOid: "blob-a", extractor: "OLD", references: [] },
    ]);
    const plan = planIncrementalReferences([file], previous, "structural-refs-v1");
    expect(plan.reuse).toHaveLength(0);
    expect(plan.toExtract.map((f) => f.blobOid)).toEqual(["blob-a"]);
  });
});
