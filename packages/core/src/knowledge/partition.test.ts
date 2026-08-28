import { describe, expect, it } from "vitest";
import type { ImportEdge, ImportGraph } from "../project-context";
import { materializeSnapshot } from "../project-context";
import { buildSnapshot, type SnapshotStructuralInputs } from "../project-snapshot";
import {
  buildModuleBatches,
  buildPartitions,
  MAX_BATCH_SIZE,
  NEIGHBOR_CAP,
  POOLED_BATCH_CAP,
  partitionIdFamily,
  partitionsFromSnapshot,
} from "./partition";

function file(path: string) {
  return { path, blobOid: `oid-${path}` };
}

function files(prefix: string, count: number, sub = "") {
  return Array.from({ length: count }, (_, i) =>
    file(sub === "" ? `${prefix}/f${i}.ts` : `${prefix}/${sub}/f${i}.ts`),
  );
}

/** Union of slices equals the inventory and no file appears twice. */
function assertTotalCoverage(
  slices: readonly { files: readonly { path: string }[] }[],
  inventory: readonly { path: string }[],
) {
  const seen = slices.flatMap((slice) => slice.files.map((f) => f.path));
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual(inventory.map((f) => f.path).sort());
}

describe("buildPartitions", () => {
  const scopes = [
    { name: "@x/core", root: "packages/core" },
    { name: "@x/ui", root: "packages/ui" },
  ];

  it("covers every file exactly once: one slice per scope, fallback for the rest", () => {
    const inventory = [
      ...files("packages/core/src", 3),
      ...files("packages/ui/src", 2),
      file("docs/readme.md"),
      file("ROOT.md"),
    ];
    const slices = buildPartitions({ files: inventory, scopes }, 120);
    assertTotalCoverage(slices, inventory);
    expect(slices.map((s) => s.id)).toEqual(["@x/core", "@x/ui", "dir:.", "dir:docs"]);
  });

  it("assigns a file under nested scope roots to the deepest root only", () => {
    const nested = [
      { name: "root-pkg", root: "" },
      { name: "@x/core", root: "packages/core" },
    ];
    const inventory = [file("packages/core/src/a.ts"), file("tools/b.ts")];
    const slices = buildPartitions({ files: inventory, scopes: nested }, 120);
    assertTotalCoverage(slices, inventory);
    const core = slices.find((s) => s.id === "@x/core");
    expect(core?.files.map((f) => f.path)).toEqual(["packages/core/src/a.ts"]);
    const root = slices.find((s) => s.id === "root-pkg");
    expect(root?.files.map((f) => f.path)).toEqual(["tools/b.ts"]);
  });

  it("subtree-splits an oversized scope until each piece is under the cap", () => {
    const inventory = [
      ...files("packages/core", 4, "src"),
      ...files("packages/core", 4, "test"),
      file("packages/core/package.json"),
    ];
    const slices = buildPartitions({ files: inventory, scopes: [scopes[0] as never] }, 4);
    assertTotalCoverage(slices, inventory);
    expect(slices.map((s) => s.id)).toEqual(["@x/core/.", "@x/core/src", "@x/core/test"]);
    for (const slice of slices) expect(slice.files.length).toBeLessThanOrEqual(4);
  });

  it("leaves a flat directory over the cap oversized rather than dropping files", () => {
    const inventory = files("packages/core", 6);
    const slices = buildPartitions({ files: inventory, scopes: [scopes[0] as never] }, 4);
    assertTotalCoverage(slices, inventory);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.files).toHaveLength(6);
  });

  it("falls back to top-level-directory slices when there are no scopes", () => {
    const inventory = [...files("src", 3), ...files("docs", 2), file("README.md")];
    const slices = buildPartitions({ files: inventory, scopes: [] }, 120);
    assertTotalCoverage(slices, inventory);
    expect(slices.map((s) => s.id)).toEqual(["dir:.", "dir:docs", "dir:src"]);
  });

  it("keeps duplicate scope NAMES distinct: exactly-once coverage, collision-free ids", () => {
    const dupNames = [
      { name: "app", root: "apps/web" },
      { name: "app", root: "apps/desktop" },
    ];
    const inventory = [file("apps/web/a.ts"), file("apps/desktop/b.ts")];
    const slices = buildPartitions({ files: inventory, scopes: dupNames }, 120);
    assertTotalCoverage(slices, inventory);
    expect(slices.map((s) => s.id)).toEqual(["app:apps/desktop", "app:apps/web"]);
    // A fully duplicated scope entry collapses to one group, never a double emit.
    const dupEntry = buildPartitions(
      { files: inventory, scopes: [...dupNames, dupNames[0] as never] },
      120,
    );
    assertTotalCoverage(dupEntry, inventory);
  });

  it("is deterministic: same snapshot yields identical slices regardless of input order", () => {
    const inventory = [...files("packages/core/src", 5), ...files("docs", 2), file("ROOT.md")];
    const shuffled = [...inventory].reverse();
    const a = buildPartitions({ files: inventory, scopes }, 3);
    const b = buildPartitions({ files: shuffled, scopes: [...scopes].reverse() }, 3);
    expect(b).toEqual(a);
  });
});

// ── Module batching (Louvain over the import graph, W2) ──────────────────────

function graphOf(pairs: readonly (readonly [string, string])[]): ImportGraph {
  const edges: ImportEdge[] = pairs.map(([from, to]) => ({
    from,
    to,
    kind: "relative" as const,
    specifier: `./${to}`,
  }));
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of edges) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, new Set()).get(edge.from))?.add(edge.to);
    (incoming.get(edge.to) ?? incoming.set(edge.to, new Set()).get(edge.to))?.add(edge.from);
  }
  const sortedOf = (index: Map<string, Set<string>>, path: string): readonly string[] =>
    [...(index.get(path) ?? [])].sort();
  return {
    edges,
    importsOf: (path) => sortedOf(outgoing, path),
    importersOf: (path) => sortedOf(incoming, path),
  };
}

/** Every pair inside a group, so Louvain sees an unambiguous community. */
function clique(paths: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      out.push([paths[i] as string, paths[j] as string]);
    }
  }
  return out;
}

const exportsOf = (path: string): readonly string[] => [
  `X_${path.slice(path.lastIndexOf("/") + 1).replace(/\W/g, "_")}`,
];

const CLUSTER_A = Array.from({ length: 6 }, (_, i) => `packages/a/src/f${i}.ts`);
const CLUSTER_B = Array.from({ length: 6 }, (_, i) => `packages/b/src/g${i}.ts`);
const TWO_CLUSTERS = {
  files: [...CLUSTER_A, ...CLUSTER_B].map(file),
  scopes: [
    { name: "@x/a", root: "packages/a" },
    { name: "@x/b", root: "packages/b" },
  ],
  // Two cliques joined by ONE bridge — the edge the batching must cut, and the
  // one the neighbour map has to report.
  graph: graphOf([
    ...clique(CLUSTER_A),
    ...clique(CLUSTER_B),
    [CLUSTER_A[5] as string, CLUSTER_B[0] as string],
  ]),
  exportsOf,
};

describe("buildModuleBatches — communities, not directories", () => {
  it("splits two cliques joined by one bridge into two batches, covering every file once", () => {
    const batches = buildModuleBatches(TWO_CLUSTERS);
    assertTotalCoverage(batches, TWO_CLUSTERS.files);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.files.map((f) => f.path)).toEqual(CLUSTER_A);
    expect(batches[1]?.files.map((f) => f.path)).toEqual(CLUSTER_B);
  });

  it("is DETERMINISTIC: two builds from shuffled inputs are deeply equal", () => {
    const first = buildModuleBatches(TWO_CLUSTERS);
    const second = buildModuleBatches({
      ...TWO_CLUSTERS,
      files: [...TWO_CLUSTERS.files].reverse(),
      scopes: [...TWO_CLUSTERS.scopes].reverse(),
    });
    expect(second).toEqual(first);
    // And a plain rebuild of the same input reproduces every id, which is what
    // makes a no-change refresh re-run nothing.
    expect(buildModuleBatches(TWO_CLUSTERS).map((b) => b.id)).toEqual(first.map((b) => b.id));
  });

  it("derives ids from CONTENT, so an untouched batch keeps its id when a sibling changes", () => {
    const before = buildModuleBatches(TWO_CLUSTERS);
    // Remove one file from cluster B. Cluster A is untouched.
    const trimmed = CLUSTER_B.slice(0, 5);
    const after = buildModuleBatches({
      files: [...CLUSTER_A, ...trimmed].map(file),
      scopes: TWO_CLUSTERS.scopes,
      graph: graphOf([
        ...clique(CLUSTER_A),
        ...clique(trimmed),
        [CLUSTER_A[5] as string, CLUSTER_B[0] as string],
      ]),
      exportsOf,
    });
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[1]?.id).not.toBe(before[1]?.id);
    // The FAMILY survives, which is what lets routeDelta recognise the successor.
    expect(partitionIdFamily(after[1]?.id ?? "")).toBe(partitionIdFamily(before[1]?.id ?? ""));
    expect(partitionIdFamily(before[1]?.id ?? "")).toBe(`mod:${CLUSTER_B[0]}`);
  });

  it("splits an oversized community into near-equal chunks, none over the max", () => {
    const big = Array.from(
      { length: 80 },
      (_, i) => `packages/a/src/f${String(i).padStart(3, "0")}.ts`,
    );
    const batches = buildModuleBatches({
      files: big.map(file),
      scopes: [{ name: "@x/a", root: "packages/a" }],
      graph: graphOf(clique(big)),
      exportsOf,
    });
    assertTotalCoverage(batches, big.map(file));
    expect(batches).toHaveLength(3);
    for (const batch of batches) expect(batch.files.length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
    expect(batches.map((b) => b.files.length)).toEqual([27, 27, 26]);
    // Chunking is over SORTED paths, so each chunk is a contiguous run.
    expect(batches[0]?.files.map((f) => f.path)).toEqual(big.slice(0, 27));
  });

  it("pools sub-minimum communities within a scope, capped, rather than one turn each", () => {
    // Twelve disjoint pairs in one scope: each is its own two-file community.
    const pairs = Array.from(
      { length: 12 },
      (_, i) =>
        [
          `packages/a/src/p${String(i).padStart(2, "0")}-x.ts`,
          `packages/a/src/p${String(i).padStart(2, "0")}-y.ts`,
        ] as const,
    );
    const paths = pairs.flat();
    const batches = buildModuleBatches({
      files: paths.map(file),
      scopes: [{ name: "@x/a", root: "packages/a" }],
      graph: graphOf(pairs),
      exportsOf,
    });
    assertTotalCoverage(batches, paths.map(file));
    // 24 files ⇒ one pooled batch (under the cap), not 12 two-file turns.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.files).toHaveLength(24);
    expect(batches[0]?.files.length).toBeLessThanOrEqual(POOLED_BATCH_CAP);
  });

  it("keeps pooling inside a scope: two packages' leftovers never blend", () => {
    const aPairs = Array.from(
      { length: 2 },
      (_, i) => [`packages/a/src/p${i}-x.ts`, `packages/a/src/p${i}-y.ts`] as const,
    );
    const bPairs = Array.from(
      { length: 2 },
      (_, i) => [`packages/b/src/q${i}-x.ts`, `packages/b/src/q${i}-y.ts`] as const,
    );
    const batches = buildModuleBatches({
      files: [...aPairs.flat(), ...bPairs.flat()].map(file),
      scopes: TWO_CLUSTERS.scopes,
      graph: graphOf([...aPairs, ...bPairs]),
      exportsOf,
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]?.files.every((f) => f.path.startsWith("packages/a/"))).toBe(true);
    expect(batches[1]?.files.every((f) => f.path.startsWith("packages/b/"))).toBe(true);
  });

  it("sends edge-less files to the directory fallback tier, still covering every file once", () => {
    const isolated = [file("docs/guide.md"), file("packages/a/README.md")];
    const batches = buildModuleBatches({
      ...TWO_CLUSTERS,
      files: [...TWO_CLUSTERS.files, ...isolated],
    });
    assertTotalCoverage(batches, [...TWO_CLUSTERS.files, ...isolated]);
    const fallback = batches.filter((b) => !b.id.startsWith("mod:"));
    expect(fallback.map((b) => b.id)).toEqual(["@x/a", "dir:docs"]);
    expect(fallback.every((b) => b.neighbors.length === 0)).toBe(true);
  });
});

describe("neighborMap — the edges batching cut, handed back", () => {
  it("records only CROSS-batch neighbours, with direction and exported names", () => {
    const batches = buildModuleBatches(TWO_CLUSTERS);
    const a = batches[0] as (typeof batches)[number];
    // Only the bridge endpoint has an outside neighbour; its five clique siblings
    // are in the same batch and must NOT appear.
    expect(a.neighbors.map((n) => n.path)).toEqual([CLUSTER_A[5]]);
    const bridge = a.neighbors[0];
    expect(bridge?.neighbors).toEqual([
      { path: CLUSTER_B[0], direction: "imports", symbols: ["X_g0_ts"] },
    ]);
    expect(bridge?.truncated).toBe(0);

    // The other side sees the same edge, from the other direction.
    const b = batches[1] as (typeof batches)[number];
    expect(b.neighbors[0]?.neighbors[0]).toEqual({
      path: CLUSTER_A[5],
      direction: "imported-by",
      symbols: ["X_f5_ts"],
    });
  });

  it("caps a hub's neighbour list and REPORTS the truncation rather than hiding it", () => {
    const hub = "packages/a/src/a-hub.ts";
    const leaves = Array.from(
      { length: 80 },
      (_, i) => `packages/a/src/leaf${String(i).padStart(3, "0")}.ts`,
    );
    const batches = buildModuleBatches({
      files: [hub, ...leaves].map(file),
      scopes: [{ name: "@x/a", root: "packages/a" }],
      graph: graphOf(leaves.map((leaf) => [hub, leaf] as const)),
      exportsOf,
    });
    assertTotalCoverage(batches, [hub, ...leaves].map(file));
    const owning = batches.find((b) => b.files.some((f) => f.path === hub));
    const entry = owning?.neighbors.find((n) => n.path === hub);
    expect(entry?.neighbors).toHaveLength(NEIGHBOR_CAP);
    // 80 leaves, 26 of them in the hub's own chunk ⇒ 54 outside, 50 kept, 4 dropped.
    expect(entry?.truncated).toBe(4);
    expect(entry?.neighbors.every((n) => !owning?.files.some((f) => f.path === n.path))).toBe(true);
  });
});

// ── The snapshot wiring: classification, batching, and honest degradation ────

describe("partitionsFromSnapshot", () => {
  function snapshotOf(options: { withImports?: boolean } = {}) {
    const tree: Record<string, string[]> = {
      "packages/a/src/index.ts": ["./one", "./two"],
      "packages/a/src/one.ts": ["./two"],
      "packages/a/src/two.ts": [],
      // Ineligible by path: a checked-in build output and a lockfile.
      "packages/a/dist/index.js": [],
      "pnpm-lock.yaml": [],
      "assets/logo.png": [],
    };
    const paths = Object.keys(tree).sort();
    const inputs: SnapshotStructuralInputs = {
      repoKey: "/repo/.git",
      baseRef: "main",
      baseRefResolution: "symbolic-head",
      baseOid: "oid-batch",
      files: paths.map((path) => ({ path, blobOid: `blob:${path}`, size: 1, mode: "100644" })),
      scopes: [
        {
          name: "@x/a",
          root: "packages/a",
          sourceRoot: "packages/a/src",
          private: true,
          tags: [],
        },
      ],
      edges: [],
      entryPoints: [],
      tests: [],
      ownership: [],
      conventions: [],
    };
    const built = buildSnapshot(
      inputs,
      paths.map((path) => ({
        blobOid: `blob:${path}`,
        extractor: "structural-ts-v2",
        generated: false,
        symbols: [{ name: `X_${path}`, kind: "const" as const, line: 1 }],
      })),
      [],
      options.withImports === false
        ? []
        : paths.map((path) => ({
            blobOid: `blob:${path}`,
            extractor: "structural-imports-v1",
            imports: [...(tree[path] ?? [])].sort(),
          })),
    );
    const result = materializeSnapshot(built.manifest, (d) => built.shards.get(d));
    if (!result.ok) throw new Error("materialize failed");
    return result.snapshot;
  }

  it("batches only the mapping-ELIGIBLE files; excluded ones consume no turn", () => {
    const slices = partitionsFromSnapshot(snapshotOf());
    const batched = slices.flatMap((s) => s.files.map((f) => f.path));
    expect(batched).toContain("packages/a/src/index.ts");
    expect(batched).not.toContain("packages/a/dist/index.js");
    expect(batched).not.toContain("pnpm-lock.yaml");
    expect(batched).not.toContain("assets/logo.png");
    // The three connected sources form one module batch.
    expect(slices.filter((s) => s.id.startsWith("mod:"))).toHaveLength(1);
  });

  it("degrades to the directory tier when the import index is withheld, never crashing", () => {
    const slices = partitionsFromSnapshot(snapshotOf({ withImports: false }));
    expect(slices.every((s) => !s.id.startsWith("mod:"))).toBe(true);
    expect(slices.map((s) => s.id)).toEqual(["@x/a"]);
    // Still eligibility-filtered, and still every eligible file exactly once.
    expect(slices.flatMap((s) => s.files.map((f) => f.path))).toEqual([
      "packages/a/src/index.ts",
      "packages/a/src/one.ts",
      "packages/a/src/two.ts",
    ]);
  });
});
