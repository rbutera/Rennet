import type { ProjectMapPayload } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildScopes } from "./model";

function map(over: Partial<ProjectMapPayload>): ProjectMapPayload {
  return {
    baseRef: "main",
    baseRefResolution: "symbolic-head",
    baseOid: "oid",
    fingerprint: "fp",
    files: [],
    scopes: [],
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
    ...over,
  };
}

describe("buildScopes ownership", () => {
  it('gives a root-"" scope the files a deeper scope does not claim', () => {
    const scopes = buildScopes(
      map({
        files: [
          { path: "packages/core/src/index.ts", blobOid: "b1", size: 1, mode: "100644" },
          { path: "README.md", blobOid: "b2", size: 1, mode: "100644" },
        ],
        scopes: [
          { name: "@root", root: "", private: false, tags: [] },
          { name: "@rennet/core", root: "packages/core", private: false, tags: [] },
        ],
      }),
    );
    const core = scopes.find((s) => s.name === "@rennet/core");
    const root = scopes.find((s) => s.name === "@root");
    // The deeper scope claims its file; the leftover falls to the real root scope,
    // NOT the synthetic "(repo root)" node.
    expect(core?.tree.fileCount).toBe(1);
    expect(root?.tree.fileCount).toBe(1);
    expect(scopes.some((s) => s.name === "(repo root)")).toBe(false);
  });
});
