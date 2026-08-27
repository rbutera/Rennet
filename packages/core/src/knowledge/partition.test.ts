import { describe, expect, it } from "vitest";
import { buildPartitions } from "./partition";

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

  it("is deterministic: same snapshot yields identical slices regardless of input order", () => {
    const inventory = [...files("packages/core/src", 5), ...files("docs", 2), file("ROOT.md")];
    const shuffled = [...inventory].reverse();
    const a = buildPartitions({ files: inventory, scopes }, 3);
    const b = buildPartitions({ files: shuffled, scopes: [...scopes].reverse() }, 3);
    expect(b).toEqual(a);
  });
});
