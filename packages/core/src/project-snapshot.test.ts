import { sha256Hex } from "@rennet/protocol";
import type {
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  OwnershipRule,
  SnapshotFileEntry,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  computeFingerprint,
  DEFAULT_SYMBOL_EXTRACTOR_ID,
  eligibleSymbolFiles,
  extractSymbolShard,
  indexSymbolShards,
  isSnapshotFresh,
  planIncrementalSymbols,
  type SnapshotStructuralInputs,
  serializeManifest,
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
    expect(computeFingerprint(a.baseOid, a.shards, a.symbols)).toBe(a.fingerprint);
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
