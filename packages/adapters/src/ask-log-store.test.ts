import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskEventBody } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { AskLogCorruptError, AskLogStore } from "./ask-log-store";

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

  it("appendMany stamps a contiguous batch and persists it with one atomic write", () => {
    const store = new AskLogStore(tempDir());
    store.append("s1", stage("a0"));
    const write = vi.spyOn(
      store as unknown as { write: (sessionId: string, events: unknown[]) => void },
      "write",
    );

    const appended = store.appendMany("s1", [stage("a1"), stage("a2")]);

    expect(appended.map((event) => event.seq)).toEqual([1, 2]);
    expect(appended.every((event) => event.sessionId === "s1")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.read("s1").map((event) => event.seq)).toEqual([0, 1, 2]);
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

  it("REFUSES a malformed file — read/readProjection THROW, never a silent empty log (P0 finding 1)", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    store.append("s1", stage("a1"));
    // corrupt the file (a torn write / bit-rot): the log EXISTS but cannot be trusted.
    writeFileSync(join(dir, "s1.json"), "{ not valid json");
    // Honest failure: folding this away to an empty projection would post a clean review
    // over the reviewer's lost asks — a silent lie. So it throws instead.
    expect(() => store.read("s1")).toThrow(AskLogCorruptError);
    expect(() => store.readProjection("s1")).toThrow(/corrupt/);
  });

  it("a shape-valid-JSON-but-wrong-schema file also throws (never silent empty)", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    writeFileSync(
      join(dir, "s2.json"),
      JSON.stringify({ version: 1, events: [{ kind: "bogus" }] }),
    );
    expect(() => store.read("s2")).toThrow(AskLogCorruptError);
  });

  it("throws on an unknown store version, a foreign session id, and a non-contiguous seq", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    writeFileSync(join(dir, "sv.json"), JSON.stringify({ version: 999, events: [] }));
    expect(() => store.read("sv")).toThrow(/version/);

    const foreign = {
      kind: "stage",
      ask: { id: "a1", anchor: "a:x", type: "comment", body: "b" },
      sessionId: "OTHER",
      seq: 0,
    };
    writeFileSync(join(dir, "sf.json"), JSON.stringify({ version: 1, events: [foreign] }));
    expect(() => store.read("sf")).toThrow(/another session/);

    const gap = {
      kind: "stage",
      ask: { id: "a1", anchor: "a:x", type: "comment", body: "b" },
      sessionId: "sg",
      seq: 5,
    };
    writeFileSync(join(dir, "sg.json"), JSON.stringify({ version: 1, events: [gap] }));
    expect(() => store.read("sg")).toThrow(/non-contiguous/);
  });

  it("refuses to append over a corrupt file rather than clobbering unread history", () => {
    const dir = tempDir();
    const store = new AskLogStore(dir);
    writeFileSync(join(dir, "s1.json"), "garbage");
    expect(() => store.append("s1", stage("a1"))).toThrow(AskLogCorruptError);
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

  // ── Real-process torn-write durability (P0 finding 1 / finding 10a) ──────────
  // The in-process "new store over the same dir" reload cannot catch a torn write,
  // because nothing tore. This spawns a SEPARATE writer process that half-writes the
  // log and is SIGKILL'd mid-write (a leftover `.tmp-*` shard + a truncated main file,
  // exactly what an abruptly-terminated writer leaves), then proves the real store in
  // THIS process refuses it — never a silently-empty review over the torn bytes.
  it("refuses a torn write left by a SIGKILL'd writer process (child-process durability)", () => {
    const dir = tempDir();
    const path = join(dir, "torn.json");
    const script = [
      "const fs = require('node:fs');",
      "const p = process.argv[1];",
      // A crash mid-write leaves the temp shard AND a truncated main file.
      "fs.writeFileSync(p + '.tmp-99-0', '{ \"version\": 1, \"events\": [ {');",
      'fs.writeFileSync(p, \'{ "version": 1, "events": [ { "kind": "sta\');',
      "process.kill(process.pid, 'SIGKILL');",
    ].join("\n");
    // The child is genuinely killed; SIGKILL surfaces as a null exit code / signal.
    try {
      execFileSync(process.execPath, ["-e", script, path], { stdio: "ignore" });
    } catch {
      // expected — SIGKILL
    }
    const store = new AskLogStore(dir);
    // The truncated main file EXISTS but is unreadable → honest refusal, not empty.
    expect(() => store.read("torn")).toThrow(AskLogCorruptError);
    // And append refuses to clobber the torn (possibly-recoverable) history.
    expect(() => store.append("torn", stage("a1"))).toThrow(AskLogCorruptError);
    expect(readFileSync(path, "utf8")).toContain('"kind": "sta');
  });
});
