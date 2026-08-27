import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindTarget, mintSession } from "@rennet/core";
import type { SessionThread } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rennet-sessions-"));
}

const fixed = { id: () => "sess-1", now: () => 1000 };
const codeAnchor = {
  type: "code",
  ref: { patchsetId: "ps-1", path: "a.ts", side: "head", startLine: 1, endLine: 4 },
} as const;

describe("SessionStore (#466 res. 1–2, B09 cluster 1)", () => {
  it("round-trips a session through disk", () => {
    const store = new SessionStore(tmpDir());
    const session = bindTarget(mintSession("proj-1", fixed), { branch: "feat/x", prNumber: 3 });
    store.save(session);
    expect(store.load("sess-1")).toEqual(session);
  });

  it("returns undefined for an absent or malformed file (fail-safe read)", () => {
    const dir = tmpDir();
    const store = new SessionStore(dir);
    expect(store.load("missing")).toBeUndefined();
    writeFileSync(join(dir, "junk.json"), "{ not json");
    expect(store.load("junk")).toBeUndefined();
    // a malformed file is skipped by list(), not thrown
    expect(store.list()).toEqual([]);
  });

  it("lists persisted sessions newest first", () => {
    const store = new SessionStore(tmpDir());
    store.save(mintSession("p", { id: () => "a", now: () => 100 }));
    store.save(mintSession("p", { id: () => "b", now: () => 300 }));
    store.save(mintSession("p", { id: () => "c", now: () => 200 }));
    expect(store.list().map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("archive is soft — the record survives on disk with archivedAt", () => {
    const store = new SessionStore(tmpDir(), { now: () => 5000 });
    store.save(mintSession("proj-1", fixed));
    const archived = store.archive("sess-1");
    expect(archived?.archivedAt).toBe(5000);
    const reloaded = store.load("sess-1");
    expect(reloaded?.archivedAt).toBe(5000); // still readable, just archived
  });

  it("adds a thread reference through the store (frozen union enforced)", () => {
    const store = new SessionStore(tmpDir());
    store.save(mintSession("proj-1", fixed));
    const updated = store.addThread("sess-1", { threadId: "th-1", anchor: codeAnchor });
    expect(updated?.threads).toHaveLength(1);
    expect(store.load("sess-1")?.threads[0]?.threadId).toBe("th-1");
    // an ask without an anchor is refused by the pure layer, never stored
    expect(() =>
      store.addThread("sess-1", {
        threadId: "th-2",
        ask: { intent: "x", exitLane: "round", provenance: "p", lifecycle: "staged" },
      } as unknown as SessionThread),
    ).toThrow();
  });
});
