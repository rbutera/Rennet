import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Generation, ROUND_NO_REGEN, type RoundRecord } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { GenerationStore, RoundRecordStore, RoundStoreCorruptError } from "./round-store";

const dir = () => mkdtempSync(join(tmpdir(), "generation-store-"));

const frozenGen = (id: string): Generation => ({
  id,
  patchsetId: "ps-1",
  lensBoards: { design: "board:d", decisions: "board:x" },
  absentLenses: { noise: "no-material" },
  status: "frozen",
});

describe("GenerationStore", () => {
  it("persists a minted generation that survives a fresh-store reload (restart sim)", () => {
    const d = dir();
    new GenerationStore(d).save(frozenGen("gen:ps-1"));
    // A brand-new store instance over the same on-disk state — the runtime after a restart.
    const reloaded = new GenerationStore(d).load("gen:ps-1");
    expect(reloaded?.id).toBe("gen:ps-1");
    expect(reloaded?.status).toBe("frozen");
    expect(reloaded?.lensBoards).toEqual({ design: "board:d", decisions: "board:x" });
    expect(reloaded?.absentLenses).toEqual({ noise: "no-material" });
  });

  it("returns undefined for a generation never persisted (honest absence, not fabricated)", () => {
    expect(new GenerationStore(dir()).load("gen:never-written")).toBeUndefined();
  });

  it("THROWS on a corrupt file rather than folding it away to absent", () => {
    const d = dir();
    const store = new GenerationStore(d);
    writeFileSync(join(d, `${encodeURIComponent("gen:bad")}.json`), "{ not json");
    expect(() => store.load("gen:bad")).toThrow(RoundStoreCorruptError);
  });

  it("THROWS on a schema-mismatched file (present but untrustworthy)", () => {
    const d = dir();
    const store = new GenerationStore(d);
    writeFileSync(join(d, `${encodeURIComponent("gen:wrong")}.json`), JSON.stringify({ id: 1 }));
    expect(() => store.load("gen:wrong")).toThrow(RoundStoreCorruptError);
  });
});

const commitRange = { from: "H0", to: "H1" };

/** A dispatch-path placeholder: ran a work-order, regenerated nothing (yet). */
const dispatchPlaceholder = (dispatchId: string | null = "dispatch-1"): RoundRecord => ({
  asksDispatched: ["ask-1"],
  ...(dispatchId === null
    ? {}
    : {
        dispatchId,
        sourcePatchsetId: "ps-1",
        askOccurrences: [{ id: "ask-1", revision: 3 }],
      }),
  workerCommitRange: commitRange,
  boardGeneration: ROUND_NO_REGEN,
  reportBoard: ROUND_NO_REGEN,
  outcome: "completed",
  regeneration: "pending",
  diff: "--- a\n+++ b",
  changedPaths: ["src/a.ts"],
});

/** The regeneration record for the SAME round (same commit range): real minted generation
 *  + a distinct frozen predecessor, no diff of its own. */
const regenRecord = (dispatchId: string | null = "dispatch-1"): RoundRecord => ({
  asksDispatched: ["ask-1"],
  ...(dispatchId === null
    ? {}
    : {
        dispatchId,
        sourcePatchsetId: "ps-1",
        askOccurrences: [{ id: "ask-1", revision: 3 }],
      }),
  workerCommitRange: commitRange,
  mintedPatchsetGeneration: "gen:H1",
  boardGeneration: "gen:H1",
  reportBoard: "board:report",
  frozenPredecessor: "gen:H0",
});

describe("RoundRecordStore", () => {
  it("reconciles the dispatch placeholder + the regeneration record into ONE durable record", () => {
    const store = new RoundRecordStore(dir());
    store.record("s1", dispatchPlaceholder());
    store.record("s1", regenRecord());
    const records = store.read("s1");
    // ONE record, not two — the regeneration superseded the placeholder in place.
    expect(records).toHaveLength(1);
    const [only] = records;
    // The REAL minted generation, not ROUND_NO_REGEN.
    expect(only?.boardGeneration).toBe("gen:H1");
    // The frozen-predecessor id, distinct from the minted id (the F3 shape, un-parked).
    expect(only?.frozenPredecessor).toBe("gen:H0");
    expect(only?.frozenPredecessor).not.toBe(only?.boardGeneration);
    // The placeholder's checkpoint truth (diff/outcome/changedPaths) is preserved.
    expect(only?.diff).toBe("--- a\n+++ b");
    expect(only?.outcome).toBe("completed");
    expect(only?.changedPaths).toEqual(["src/a.ts"]);
  });

  it("keeps ROUND_NO_REGEN for a dispatch-only round (no regeneration follows)", () => {
    const store = new RoundRecordStore(dir());
    store.record("s2", dispatchPlaceholder());
    const [only] = store.read("s2");
    expect(only?.boardGeneration).toBe(ROUND_NO_REGEN);
    expect(only?.frozenPredecessor).toBeUndefined();
  });

  it("updates a completed placeholder from pending to terminal no-code in place", () => {
    const store = new RoundRecordStore(dir());
    store.record("s-no-code", dispatchPlaceholder());
    store.record("s-no-code", { ...dispatchPlaceholder(), regeneration: "not-needed" });
    const records = store.read("s-no-code");
    expect(records).toHaveLength(1);
    expect(records[0]?.regeneration).toBe("not-needed");
    expect(records[0]?.boardGeneration).toBe(ROUND_NO_REGEN);
  });

  it("does not reconcile modern dispatches that share a commit range but have different identities", () => {
    const store = new RoundRecordStore(dir());
    store.record("s-identities", dispatchPlaceholder("dispatch-1"));
    store.record("s-identities", regenRecord("dispatch-2"));
    expect(store.read("s-identities")).toHaveLength(2);
  });

  it("reconciles by dispatch identity even when the observed commit range differs", () => {
    const store = new RoundRecordStore(dir());
    store.record("s-range", dispatchPlaceholder("dispatch-1"));
    store.record("s-range", {
      ...regenRecord("dispatch-1"),
      workerCommitRange: { from: "other-from", to: "other-to" },
    });
    const records = store.read("s-range");
    expect(records).toHaveLength(1);
    expect(records[0]?.boardGeneration).toBe("gen:H1");
    expect(records[0]?.diff).toBe("--- a\n+++ b");
  });

  it("keeps the commit-range reconciliation fallback for two legacy records", () => {
    const store = new RoundRecordStore(dir());
    store.record("s-legacy", dispatchPlaceholder(null));
    store.record("s-legacy", regenRecord(null));
    expect(store.read("s-legacy")).toHaveLength(1);
  });

  it("never reconciles a failed placeholder into a successful generation", () => {
    const store = new RoundRecordStore(dir());
    store.record("s-failed", { ...dispatchPlaceholder("dispatch-1"), outcome: "failed" });
    store.record("s-failed", regenRecord("dispatch-1"));
    expect(store.read("s-failed")).toHaveLength(2);
  });

  it("survives a fresh-store reload (restart sim) and reads the reconciled record back", () => {
    const d = dir();
    const a = new RoundRecordStore(d);
    a.record("s3", dispatchPlaceholder());
    a.record("s3", regenRecord());
    // A first-generation round (no predecessor) as a second, distinct round.
    a.record("s3", {
      asksDispatched: ["ask-2"],
      workerCommitRange: { from: "H1", to: "H1" },
      boardGeneration: "gen:H1",
      reportBoard: "board:r2",
    });
    const reloaded = new RoundRecordStore(d).read("s3");
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0]?.frozenPredecessor).toBe("gen:H0");
    expect(reloaded[1]?.frozenPredecessor).toBeUndefined();
  });

  it("is honestly empty for a session never recorded", () => {
    expect(new RoundRecordStore(dir()).read("s-none")).toEqual([]);
  });

  it("THROWS on a corrupt ledger rather than dropping the reviewer's round history", () => {
    const d = dir();
    const store = new RoundRecordStore(d);
    writeFileSync(join(d, `${encodeURIComponent("s4")}.json`), "{ broken");
    expect(() => store.read("s4")).toThrow(RoundStoreCorruptError);
  });
});
