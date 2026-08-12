import type { NoveltyLedger } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { NoveltyLifecycleRegistry } from "./novelty-lifecycle-registry";

function ledger(classification: "novel" | "extends", projectSnapshotId: string): NoveltyLedger {
  return {
    projectSnapshotId,
    snapshotFingerprint: projectSnapshotId,
    baseOid: projectSnapshotId,
    patchsetId: "patch",
    entries: [
      {
        unit: { kind: "file", path: "src/a.ts", fileStatus: "modified" },
        classification,
        evidence: {
          snapshotFingerprint: projectSnapshotId,
          baseOid: projectSnapshotId,
          shard: "files",
          match: { kind: "file-present", path: "src/a.ts", blobOid: "blob" },
          context: {
            scope: null,
            isKnownTest: false,
            isConvention: false,
            patchTruncated: false,
          },
        },
      },
    ],
  };
}

describe("NoveltyLifecycleRegistry", () => {
  it("reclassifies registered live reviews when their repo baseline advances", async () => {
    const registry = new NoveltyLifecycleRegistry();
    registry.register(
      "repo",
      "review",
      { ledger: ledger("extends", "old"), judgments: new Map() },
      async () => ({ ok: true, ledger: ledger("novel", "new") }),
    );

    await registry.advanceRepo("repo");
    expect(registry.get("repo", "review")?.ledger.projectSnapshotId).toBe("new");
    expect(registry.get("repo", "review")?.ledger.entries[0]?.classification).toBe("novel");
    expect(registry.getLastAdvance("repo", "review")?.pendingEntryKeys).toHaveLength(1);
  });
});
