import type {
  CanvasOpsBackend,
  ProjectReferenceResult,
  ProjectSymbolDefinitionResult,
} from "@rennet/core";
import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  createLiveSymbolLookup,
  definitionNeighbors,
  lookupSymbol,
  reviewPinnedToHead,
  symbolDefinitionSection,
  symbolReferencesSection,
} from "./symbol-lookup-live";

describe("symbolDefinitionSection", () => {
  it("projects the definition sites of an ok result", () => {
    const result: ProjectSymbolDefinitionResult = {
      ok: true,
      definitions: {
        name: "makeThing",
        sites: [
          { path: "src/thing.ts", name: "makeThing", kind: "function", line: 12, scope: "pkg" },
        ],
      },
    };
    expect(symbolDefinitionSection(result)).toEqual({
      status: "ok",
      sites: [{ path: "src/thing.ts", line: 12, kind: "function", scope: "pkg" }],
      tier: { kind: "exact", method: "structural" },
    });
  });

  it("labels a SINGLE structural site `exact` and SEVERAL sites a `guess` with candidates", () => {
    const one: ProjectSymbolDefinitionResult = {
      ok: true,
      definitions: {
        name: "Widget",
        sites: [{ path: "a.ts", name: "Widget", kind: "class", line: 1, scope: null }],
      },
    };
    const many: ProjectSymbolDefinitionResult = {
      ok: true,
      definitions: {
        name: "Widget",
        sites: [
          { path: "a.ts", name: "Widget", kind: "class", line: 1, scope: null },
          { path: "b.ts", name: "Widget", kind: "class", line: 2, scope: null },
        ],
      },
    };
    const single = symbolDefinitionSection(one);
    const several = symbolDefinitionSection(many);
    if (single.status !== "ok" || several.status !== "ok") throw new Error("expected ok");
    expect(single.tier).toEqual({ kind: "exact", method: "structural" });
    // Never fabricated: two declarations of one name cannot be `exact`.
    expect(several.tier).toEqual({ kind: "guess", method: "structural", candidates: 2 });
  });

  it("attaches no tier to an empty (nothing-found) definition", () => {
    const result: ProjectSymbolDefinitionResult = {
      ok: true,
      definitions: { name: "gone", sites: [] },
    };
    const section = symbolDefinitionSection(result);
    if (section.status !== "ok") throw new Error("expected ok");
    expect(section.tier).toBeUndefined();
  });

  it("maps a shard-unavailable result to an honest unavailable section", () => {
    const result: ProjectSymbolDefinitionResult = {
      ok: false,
      reason: "shard-unavailable",
      digest: "abc",
    };
    expect(symbolDefinitionSection(result)).toEqual({
      status: "unavailable",
      reason: "the symbol index could not be read",
    });
  });

  it("maps a snapshot-unavailable result to an honest unavailable section", () => {
    const result = {
      ok: false,
      reason: "snapshot-unavailable",
      failure: { kind: "absent" },
    } as unknown as ProjectSymbolDefinitionResult;
    expect(symbolDefinitionSection(result)).toEqual({
      status: "unavailable",
      reason: "the project snapshot is not available yet",
    });
  });
});

describe("symbolReferencesSection", () => {
  it("projects reference sites, not truncated under the cap", () => {
    const result: ProjectReferenceResult = {
      ok: true,
      references: {
        name: "thing",
        sites: [
          { path: "src/a.ts", line: 1, scope: null },
          { path: "src/b.ts", line: 4, scope: "pkg" },
        ],
      },
    };
    expect(symbolReferencesSection(result, 10)).toEqual({
      status: "ok",
      sites: [
        { path: "src/a.ts", line: 1, scope: null },
        { path: "src/b.ts", line: 4, scope: "pkg" },
      ],
      truncated: false,
      // Find-references is textual/name-based — always a guess, never `exact`.
      tier: { kind: "guess", method: "textual" },
    });
  });

  it("attaches no tier to an empty references answer", () => {
    const result: ProjectReferenceResult = { ok: true, references: { name: "x", sites: [] } };
    const section = symbolReferencesSection(result);
    if (section.status !== "ok") throw new Error("expected ok");
    expect(section.tier).toBeUndefined();
  });

  it("caps the sites and flags truncated when there are more than the cap", () => {
    const sites = Array.from({ length: 5 }, (_u, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      scope: null,
    }));
    const result: ProjectReferenceResult = { ok: true, references: { name: "x", sites } };
    const section = symbolReferencesSection(result, 3);
    expect(section).toMatchObject({ status: "ok", truncated: true });
    if (section.status === "ok") expect(section.sites).toHaveLength(3);
  });

  it("maps a gate failure to unavailable", () => {
    const result: ProjectReferenceResult = { ok: false, reason: "shard-unavailable", digest: "d" };
    expect(symbolReferencesSection(result)).toEqual({
      status: "unavailable",
      reason: "the symbol index could not be read",
    });
  });
});

describe("lookupSymbol", () => {
  it("reads both symbolic ops for the clicked name over the backend", () => {
    const calls: string[] = [];
    const backend = {
      symbolDefinition: (query: { name: string }) => {
        calls.push(`def:${query.name}`);
        return {
          ok: true,
          definitions: {
            name: query.name,
            sites: [{ path: "src/x.ts", name: query.name, kind: "function", line: 3, scope: null }],
          },
        } satisfies ProjectSymbolDefinitionResult;
      },
      references: (query: { name: string }) => {
        calls.push(`ref:${query.name}`);
        return {
          ok: true,
          references: { name: query.name, sites: [{ path: "src/y.ts", line: 9, scope: null }] },
        } satisfies ProjectReferenceResult;
      },
    } as unknown as CanvasOpsBackend;

    const inspection = lookupSymbol(backend, "makeThing");
    expect(calls).toEqual(["def:makeThing", "ref:makeThing"]);
    expect(inspection.name).toBe("makeThing");
    expect(inspection.definition).toMatchObject({ status: "ok" });
    expect(inspection.references).toMatchObject({ status: "ok" });
    // No fileOverview op on this backend ⇒ no fabricated neighbours.
    expect(inspection.neighbors).toBeUndefined();
  });

  it("attaches the definition file's REAL sibling symbols as clickable neighbours", () => {
    const backend = {
      symbolDefinition: (query: { name: string }) =>
        ({
          ok: true,
          definitions: {
            name: query.name,
            sites: [
              { path: "src/bucket.ts", name: query.name, kind: "class", line: 4, scope: null },
            ],
          },
        }) satisfies ProjectSymbolDefinitionResult,
      references: (query: { name: string }) =>
        ({
          ok: true,
          references: { name: query.name, sites: [] },
        }) satisfies ProjectReferenceResult,
      fileOverview: (path: string) => ({
        ok: true as const,
        overview: {
          path,
          blobOid: "blob",
          extractor: "structural-ts-v1",
          hasSymbols: true,
          symbols: [
            { name: "TokenBucket", kind: "class", line: 4 },
            { name: "refill", kind: "function", line: 20 },
          ],
        },
      }),
    } as unknown as CanvasOpsBackend;

    const inspection = lookupSymbol(backend, "TokenBucket");
    expect(inspection.neighbors).toEqual({
      path: "src/bucket.ts",
      symbols: [
        { name: "TokenBucket", kind: "class", line: 4 },
        { name: "refill", kind: "function", line: 20 },
      ],
    });
  });
});

describe("definitionNeighbors", () => {
  const overviewBackend = (overviewOk: boolean) =>
    ({
      fileOverview: (path: string) =>
        overviewOk
          ? {
              ok: true as const,
              overview: {
                path,
                blobOid: "b",
                extractor: "structural-ts-v1",
                hasSymbols: true,
                symbols: [{ name: "sibling", kind: "function", line: 7 }],
              },
            }
          : { ok: false as const, reason: "shard-unavailable" as const, path, digest: "d" },
    }) as unknown as CanvasOpsBackend;

  it("returns undefined when the definition has no site (nothing to neighbour)", () => {
    expect(definitionNeighbors(overviewBackend(true), { status: "ok", sites: [] })).toBeUndefined();
  });

  it("returns undefined when the definition is unavailable", () => {
    expect(
      definitionNeighbors(overviewBackend(true), {
        status: "unavailable",
        reason: "the project snapshot is not available yet",
      }),
    ).toBeUndefined();
  });

  it("reads the FIRST definition site's file overview into neighbours", () => {
    const neighbors = definitionNeighbors(overviewBackend(true), {
      status: "ok",
      sites: [{ path: "src/x.ts", line: 1, kind: "function", scope: null }],
      tier: { kind: "exact", method: "structural" },
    });
    expect(neighbors).toEqual({
      path: "src/x.ts",
      symbols: [{ name: "sibling", kind: "function", line: 7 }],
    });
  });

  it("omits neighbours (never invents them) when the overview is unavailable", () => {
    expect(
      definitionNeighbors(overviewBackend(false), {
        status: "ok",
        sites: [{ path: "src/x.ts", line: 1, kind: "function", scope: null }],
        tier: { kind: "exact", method: "structural" },
      }),
    ).toBeUndefined();
  });
});

describe("reviewPinnedToHead", () => {
  const review = {
    id: "rev-1",
    activePatchsetId: "ps-2",
    patchsets: [
      { id: "ps-1", repository: { baseOid: "base1", headOid: "head1" } },
      { id: "ps-2", repository: { baseOid: "base2", headOid: "head2", baseRef: "main" } },
    ],
  } as unknown as Review;

  it("pins the ACTIVE patchset's baseOid to its headOid (the reviewed tree)", () => {
    const pinned = reviewPinnedToHead(review);
    const active = pinned.patchsets.find((p) => p.id === "ps-2");
    if (!active) throw new Error("active patchset missing");
    expect(active.repository.baseOid).toBe("head2"); // now reads the reviewed code
    expect(active.repository.headOid).toBe("head2");
    // other repository fields preserved
    expect((active.repository as { baseRef?: string }).baseRef).toBe("main");
  });

  it("leaves non-active patchsets untouched, and does not mutate the input", () => {
    const pinned = reviewPinnedToHead(review);
    expect(pinned.patchsets.find((p) => p.id === "ps-1")?.repository.baseOid).toBe("base1");
    // input unchanged
    expect(review.patchsets.find((p) => p.id === "ps-2")?.repository.baseOid).toBe("base2");
  });
});

describe("createLiveSymbolLookup", () => {
  it("builds the backend for the resolved review, then looks the name up", async () => {
    let builtFor = "";
    const backend = {
      symbolDefinition: () =>
        ({
          ok: true,
          definitions: { name: "n", sites: [] },
        }) satisfies ProjectSymbolDefinitionResult,
      references: () =>
        ({ ok: true, references: { name: "n", sites: [] } }) satisfies ProjectReferenceResult,
    } as unknown as CanvasOpsBackend;
    const lookup = createLiveSymbolLookup({
      buildBackend: async (review) => {
        builtFor = review.id;
        return backend;
      },
    });
    const review = { id: "rev-1" } as Parameters<typeof lookup>[0]["review"];
    const inspection = await lookup({ review, name: "n" });
    expect(builtFor).toBe("rev-1");
    expect(inspection).toEqual({
      name: "n",
      definition: { status: "ok", sites: [] },
      references: { status: "ok", sites: [], truncated: false },
    });
  });
});
