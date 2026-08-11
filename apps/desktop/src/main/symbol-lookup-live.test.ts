import type {
  CanvasOpsBackend,
  ProjectReferenceResult,
  ProjectSymbolDefinitionResult,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  createLiveSymbolLookup,
  lookupSymbol,
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
    });
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
    });
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
