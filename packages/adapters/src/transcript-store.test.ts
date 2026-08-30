import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTranscriptRow } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { TranscriptStore, TranscriptStoreCorruptError } from "./transcript-store";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rennet-transcript-"));
}

const turn = (id: string): SessionTranscriptRow => ({
  kind: "turn",
  id,
  speaker: "orchestrator",
  status: "complete",
  paragraphs: ["hello"],
});

describe("TranscriptStore", () => {
  it("absent log is the honest-empty state (no error)", () => {
    const store = new TranscriptStore(tmp());
    expect(store.read("nope")).toEqual([]);
  });

  it("appends survive a reload — a fresh store reads back the persisted rows", () => {
    const dir = tmp();
    new TranscriptStore(dir).append("s1", [turn("a")]);
    new TranscriptStore(dir).append("s1", [turn("b")]);
    // A brand-new store instance (simulating a daemon restart) reads the full log.
    expect(new TranscriptStore(dir).read("s1").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("an empty batch is a no-op (no fabricated file)", () => {
    const dir = tmp();
    const store = new TranscriptStore(dir);
    store.append("s2", []);
    expect(store.read("s2")).toEqual([]);
  });

  it("a corrupt file THROWS rather than folding to empty", () => {
    const dir = tmp();
    writeFileSync(join(dir, `${encodeURIComponent("s3")}.json`), "{ not json");
    const store = new TranscriptStore(dir);
    expect(() => store.read("s3")).toThrow(TranscriptStoreCorruptError);
    expect(() => store.append("s3", [turn("x")])).toThrow(TranscriptStoreCorruptError);
  });

  it("appends stable lifecycle rows once across replay and restart", () => {
    const dir = tmp();
    const store = new TranscriptStore(dir);
    store.append("s4", [turn("history")]);
    store.appendUnique("s4", [turn("round:dispatch"), turn("round:return")]);

    new TranscriptStore(dir).appendUnique("s4", [turn("round:dispatch"), turn("round:return")]);

    expect(new TranscriptStore(dir).read("s4").map((row) => row.id)).toEqual([
      "history",
      "round:dispatch",
      "round:return",
    ]);
  });

  it("deduplicates repeated ids inside one append batch", () => {
    const store = new TranscriptStore(tmp());
    store.appendUnique("s5", [turn("same"), turn("same")]);
    expect(store.read("s5").map((row) => row.id)).toEqual(["same"]);
  });
});
