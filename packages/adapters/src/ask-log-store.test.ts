import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskEventBody } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { AskLogStore } from "./ask-log-store";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ask-log-"));
}

const stage = (id: string): AskEventBody => ({
  kind: "stage",
  ask: { id, anchor: `a:${id}`, type: "comment", body: `b${id}` },
});

describe("AskLogStore", () => {
  it("round-trips a log through disk and folds to the projection", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    store.append("s1", stage("a1"));
    store.append("s1", { kind: "line-comment-set", path: "p.ts", line: 4, body: "note" });
    store.append("s1", { kind: "verdict-override-set", verdict: "APPROVE" });

    const reloaded = new AskLogStore(dir);
    const proj = reloaded.readProjection("s1");
    expect(proj.stagedAsks.a1?.body).toBe("ba1");
    expect(proj.lineComments["p.ts"]).toEqual({ "4": "note" });
    expect(proj.verdictOverride).toBe("APPROVE");
  });

  it("append is additive and stamps a monotonic seq starting at 0", () => {
    const store = new AskLogStore(tempDir());
    const e0 = store.append("s1", stage("a1"));
    const e1 = store.append("s1", stage("a2"));
    const e2 = store.append("s1", { kind: "retire", id: "a1", reason: "x" });

    expect([e0.seq, e1.seq, e2.seq]).toEqual([0, 1, 2]);
    for (const e of [e0, e1, e2]) expect(e.sessionId).toBe("s1");

    const log = store.read("s1");
    expect(log).toHaveLength(3);
    // every prior event is preserved, in order — nothing was rewritten
    expect(log.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(log[0]).toEqual(e0);
  });

  it("survives a simulated restart: a fresh store over the same file reads the same projection", () => {
    const dir = tempDir();
    const first = new AskLogStore(dir);
    first.append("s1", stage("a1"));
    first.append("s1", {
      kind: "quote-open",
      threadId: "t1",
      thread: { anchor: "s", messages: [{ author: "user", text: "hi" }] },
    });
    const before = first.readProjection("s1");

    const afterRestart = new AskLogStore(dir).readProjection("s1");
    expect(afterRestart).toEqual(before);
  });

  it("schema-validates on read: a malformed file reads as an empty log (fail-safe)", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    store.append("s1", stage("a1"));
    // corrupt the file
    writeFileSync(join(dir, "s1.json"), "{ not valid json");
    expect(store.read("s1")).toEqual([]);
    expect(store.readProjection("s1").stagedAsks).toEqual({});
  });

  it("a shape-valid-JSON-but-wrong-schema file also fails safe", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    writeFileSync(
      join(dir, "s2.json"),
      JSON.stringify({ version: 1, events: [{ kind: "bogus" }] }),
    );
    expect(store.read("s2")).toEqual([]);
  });

  it("refuses to append over a malformed file rather than clobbering unread history", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    writeFileSync(join(dir, "s1.json"), "garbage");
    expect(() => store.append("s1", stage("a1"))).toThrow(/malformed/);
    // the garbage is left untouched for a human to recover
    expect(readFileSync(join(dir, "s1.json"), "utf8")).toBe("garbage");
  });

  it("a missing log reads as empty, and the first append creates it", () => {
    const store = new AskLogStore(tempDir());
    expect(store.read("never-written")).toEqual([]);
    const e = store.append("fresh", stage("a1"));
    expect(e.seq).toBe(0);
    expect(store.read("fresh")).toHaveLength(1);
  });
});
