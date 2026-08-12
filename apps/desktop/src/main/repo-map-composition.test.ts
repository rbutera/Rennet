import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop Repo Map composition", () => {
  it("binds capture pins and background knowledge into the live root", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("ensureProjectSnapshotPin(liveSnapshotStore, repoRoot, baseOid)");
    expect(source).toContain("resolveProjectSnapshotId: (root, baseOid) =>");
    expect(source).toContain("runKnowledgePass: async ({ repoKey, repoRoot, fromOid, toOid }) =>");
    expect(source).toContain(
      "runNoveltyPass: (repoKey) => liveNoveltyLifecycle.advanceRepo(repoKey)",
    );
    expect(source).toContain(
      "resolveKnowledgePort: async () => (await getClaudeHarness()).adapter",
    );
  });
});
