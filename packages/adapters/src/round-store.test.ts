import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Generation } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { GenerationStore, RoundStoreCorruptError } from "./round-store";

const dir = () => mkdtempSync(join(tmpdir(), "generation-store-"));

const frozenGen = (id: string): Generation => ({
  id,
  patchsetId: "ps-1",
  lensBoards: { design: "board:d", decisions: "board:x" },
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
