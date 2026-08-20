import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop Repo Map composition", () => {
  it("binds capture pins and background knowledge into the live root", () => {
    const source = readFileSync(new URL("./create-server.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "ensureProjectSnapshotPin(liveSnapshotStore, repoRoot, baseOid, gitForRepo(repoRoot))",
    );
    expect(source).toContain("resolveProjectSnapshotId: (repoRoot, baseOid) =>");
    expect(source).toContain("runKnowledgePass: async ({ repoKey, repoRoot, fromOid, toOid }) =>");
    expect(source).toContain(
      "runNoveltyPass: (repoKey) => liveNoveltyLifecycle.advanceRepo(repoKey)",
    );
    // The orchestrator's knowledge port resolves the review's locus per call (#334).
    expect(source).toContain("resolveKnowledgePort: async (repoRoot) => {");
    expect(source).toContain("const { locus, distroCwd } = locusContextForRepo(repoRoot);");
  });
});
