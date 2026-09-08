import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Generation,
  type GenerationUsage,
  ROUND_NO_REGEN,
  type RoundRecord,
  type RoundRunReceipt,
} from "@rennet/protocol";
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
  it.skipIf(process.env.RENNET_ROUND_STORE_RACE_ROLE !== "generation-save")(
    "generation process writer",
    () => {
      const directory = process.env.RENNET_ROUND_STORE_RACE_DIR;
      if (directory === undefined) throw new Error("missing race directory");
      const store = new GenerationStore(directory);
      store.save({
        ...frozenGen("gen:process"),
        status: "live",
        draftingReportBoardId: "child-attempt",
      });
      store.close();
    },
  );

  it("rejects the revision observed before another process replaced the generation", () => {
    const directory = dir();
    const store = new GenerationStore(directory);
    store.save({ ...frozenGen("gen:process"), status: "live" });
    const observed = store.loadVersion("gen:process");
    if (observed === undefined) throw new Error("missing generation");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        fileURLToPath(import.meta.url),
        "-t",
        "generation process writer",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          RENNET_ROUND_STORE_RACE_ROLE: "generation-save",
          RENNET_ROUND_STORE_RACE_DIR: directory,
        },
        timeout: 20_000,
      },
    );
    expect(store.saveIfRevision(observed.generation, observed.revision)).toBe(false);
    expect(store.freeze("gen:process", observed.revision)).toBeUndefined();
    expect(store.load("gen:process")?.draftingReportBoardId).toBe("child-attempt");
    expect(store.load("gen:process")?.status).toBe("live");
    store.close();
  }, 25_000);

  it("conditionally freezes the observed revision across independent store instances", () => {
    const d = dir();
    const first = new GenerationStore(d);
    const second = new GenerationStore(d);
    const live: Generation = { ...frozenGen("gen:race"), status: "live" };
    first.save(live);
    const observed = first.loadVersion(live.id);
    expect(observed).toBeDefined();
    if (observed === undefined) throw new Error("missing saved generation");
    second.save({ ...live, draftingReportBoardId: "new-attempt" });
    expect(first.saveIfRevision({ ...live, status: "frozen" }, observed.revision)).toBe(false);
    expect(first.freeze(live.id, observed.revision)).toBeUndefined();
    expect(first.load(live.id)).toEqual({ ...live, draftingReportBoardId: "new-attempt" });
    const current = second.loadVersion(live.id);
    if (current === undefined) throw new Error("missing replacement generation");
    expect(second.freeze(live.id, current.revision)?.status).toBe("frozen");
    expect(first.load(live.id)?.status).toBe("frozen");
    expect(first.freeze(live.id, current.revision)).toBeUndefined();
    const frozen = first.loadVersion(live.id);
    if (frozen === undefined) throw new Error("missing frozen generation");
    expect(
      first.saveIfRevision({ ...frozen.generation, compositionBoardId: "report" }, frozen.revision),
    ).toBe(true);
    expect(second.load(live.id)?.compositionBoardId).toBe("report");
    expect(second.loadVersion(live.id)?.revision).toBe(frozen.revision + 1);
    first.close();
    second.close();
  });

  it("promotes legacy JSON without losing its contents or accepting a stale revision", () => {
    const d = dir();
    const gen = frozenGen("gen:legacy");
    writeFileSync(join(d, `${encodeURIComponent(gen.id)}.json`), JSON.stringify(gen));
    const first = new GenerationStore(d);
    const observed = first.loadVersion(gen.id);
    expect(observed?.generation).toEqual(gen);
    const second = new GenerationStore(d);
    second.save({ ...gen, status: "live" });
    expect(first.freeze(gen.id, observed?.revision ?? -1)).toBeUndefined();
    expect(first.load(gen.id)?.status).toBe("live");
    first.close();
    second.close();
  });

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

  it("reloads board tool-call measurements while legacy usage remains unknown", () => {
    const directory = dir();
    const usage: GenerationUsage = {
      turns: 2,
      unmeasuredTurns: 1,
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 12,
      reportedUsd: null,
    };
    const store = new GenerationStore(directory);
    store.save({ ...frozenGen("measured"), usage: { ...usage, boardToolCalls: 9 } });
    store.save({ ...frozenGen("zero"), usage: { ...usage, boardToolCalls: 0 } });
    store.save({ ...frozenGen("legacy"), usage });
    store.close();
    const reloaded = new GenerationStore(directory);
    try {
      expect(reloaded.load("measured")?.usage).toHaveProperty("boardToolCalls", 9);
      expect(reloaded.load("zero")?.usage).toHaveProperty("boardToolCalls", 0);
      expect(reloaded.load("legacy")?.usage).not.toHaveProperty("boardToolCalls");
    } finally {
      reloaded.close();
    }
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
const RUN_RECEIPT: RoundRunReceipt = {
  startedAt: 1_777_777_777_000,
  sourceTarget: { kind: "branch", branch: "feat/receipts" },
};

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
  run: RUN_RECEIPT,
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
  it("keeps one completed dispatch when its completion or placeholder is replayed", () => {
    const store = new RoundRecordStore(dir());
    store.record("replay", dispatchPlaceholder());
    store.record("replay", regenRecord());
    store.record("replay", regenRecord());
    store.record("replay", dispatchPlaceholder());
    expect(store.read("replay")).toHaveLength(1);
    expect(store.read("replay")[0]?.boardGeneration).toBe("gen:H1");
    expect(store.read("replay")[0]?.diff).toBe("--- a\n+++ b");
  });

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
    expect(only?.run).toEqual(RUN_RECEIPT);
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

  it("keeps the first immutable run receipt across same-dispatch retries and regeneration", () => {
    const d = dir();
    const store = new RoundRecordStore(d);
    store.record("s-receipt", dispatchPlaceholder());
    store.record("s-receipt", {
      ...dispatchPlaceholder(),
      run: {
        startedAt: RUN_RECEIPT.startedAt + 1,
        sourceTarget: { kind: "detached", head: "wrong-head" },
      },
    });
    store.record("s-receipt", {
      ...regenRecord(),
      run: {
        startedAt: RUN_RECEIPT.startedAt + 2,
        sourceTarget: { kind: "branch", branch: "wrong-branch" },
      },
    });

    expect(new RoundRecordStore(d).read("s-receipt")[0]?.run).toEqual(RUN_RECEIPT);
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
    expect(reloaded[0]?.run).toEqual(RUN_RECEIPT);
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
