import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop Repo Map composition", () => {
  it("binds capture pins and the background passes into the live root", () => {
    const source = readFileSync(new URL("./create-server.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "ensureProjectSnapshotPin(liveSnapshotStore, repoRoot, baseOid, gitForRepo(repoRoot))",
    );
    expect(source).toContain("resolveProjectSnapshotId: (repoRoot, baseOid) =>");
    expect(source).toContain(
      "runNoveltyPass: (repoKey) => liveNoveltyLifecycle.advanceRepo(repoKey)",
    );
  });
});
