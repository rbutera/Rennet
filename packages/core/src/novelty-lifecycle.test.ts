import type { LedgerEntry, NoveltyLedger, Stage2NoveltyJudgment } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  advanceNoveltyLifecycle,
  applyNoveltyRegeneration,
  composeNoveltyFeed,
  diffNoveltyClassifications,
  noveltyEntryKey,
  validateStage2NoveltyJudgment,
} from "./novelty-lifecycle";

function entry(classification: "novel" | "extends" | "conforms", path = "src/a.ts"): LedgerEntry {
  return {
    unit: { kind: "file", path, fileStatus: "modified" },
    classification,
    evidence: {
      snapshotFingerprint: "snapshot",
      baseOid: "base",
      shard: "files",
      match: { kind: "file-present", path, blobOid: "blob" },
      context: { scope: null, isKnownTest: false, isConvention: false, patchTruncated: false },
    },
  };
}

function ledger(entries: readonly LedgerEntry[], projectSnapshotId = "snapshot"): NoveltyLedger {
  return {
    projectSnapshotId,
    snapshotFingerprint: "snapshot",
    baseOid: "base",
    patchsetId: "patch",
    entries,
  };
}

describe("novelty lifecycle", () => {
  it("surfaces only classification flips", () => {
    const same = entry("extends");
    const flip = entry("conforms", "src/b.test.ts");
    const changes = diffNoveltyClassifications(
      ledger([same, flip]),
      ledger([entry("extends"), entry("novel", "src/b.test.ts")], "next"),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        entryKey: noveltyEntryKey(flip),
        previous: expect.objectContaining({ classification: "conforms" }),
        current: expect.objectContaining({ classification: "novel" }),
      }),
    ]);
  });

  it("keeps prior judgments visible until replacements are applied", () => {
    const oldEntry = entry("conforms");
    const oldJudgment: Stage2NoveltyJudgment = {
      status: "hypothesis",
      entryKey: noveltyEntryKey(oldEntry),
      classification: "conforms",
      rationale: "old output remains readable",
    };
    const state = {
      ledger: ledger([oldEntry]),
      judgments: new Map([[oldJudgment.entryKey, oldJudgment]]),
    };
    const advanced = advanceNoveltyLifecycle(state, ledger([entry("novel")], "next"));
    expect(advanced.next.judgments.get(oldJudgment.entryKey)).toBe(oldJudgment);
    expect(advanced.pendingEntryKeys).toEqual([oldJudgment.entryKey]);

    const replacement: Stage2NoveltyJudgment = {
      ...oldJudgment,
      classification: "novel",
      rationale: "new",
    };
    expect(
      applyNoveltyRegeneration(
        advanced.next,
        new Map([[oldJudgment.entryKey, replacement]]),
      ).judgments.get(oldJudgment.entryKey),
    ).toBe(replacement);
  });
});

describe("novelty Stage-2 contract", () => {
  it("orders baseline material before the diff and novelty sections", () => {
    const feed = composeNoveltyFeed({
      baseline: ["map shard"],
      primer: "primer",
      knowledge: ["knowledge"],
      diffPack: "diff",
      novelty: "ledger",
    });
    expect(feed.indexOf("map shard")).toBeLessThan(feed.indexOf("diff"));
    expect(feed.indexOf("primer")).toBeLessThan(feed.indexOf("diff"));
    expect(feed.indexOf("knowledge")).toBeLessThan(feed.indexOf("diff"));
    expect(feed.indexOf("diff")).toBeLessThan(feed.indexOf("ledger"));
  });

  it("requires evidence for a finding but admits the same claim as a hypothesis", () => {
    const uncited = { entryKey: "entry", classification: "novel", rationale: "unseen pattern" };
    expect(validateStage2NoveltyJudgment({ status: "finding", ...uncited })).toEqual({
      ok: false,
      reason: "a finding must cite evidence",
    });
    expect(validateStage2NoveltyJudgment({ status: "hypothesis", ...uncited }).ok).toBe(true);
    expect(
      validateStage2NoveltyJudgment(
        {
          status: "finding",
          ...uncited,
          evidence: [{ kind: "snapshot-shard", projectSnapshotId: "snapshot", shardRef: "files" }],
        },
        (evidence) =>
          evidence.kind === "snapshot-shard" && evidence.projectSnapshotId === "snapshot",
      ).ok,
    ).toBe(true);
    expect(
      validateStage2NoveltyJudgment({
        status: "finding",
        ...uncited,
        evidence: [{ kind: "knowledge", statementId: "" }],
      }).ok,
    ).toBe(false);
    expect(
      validateStage2NoveltyJudgment(
        {
          status: "finding",
          ...uncited,
          evidence: [{ kind: "snapshot-shard", projectSnapshotId: "missing", shardRef: "files" }],
        },
        () => false,
      ).ok,
    ).toBe(false);
  });
});
