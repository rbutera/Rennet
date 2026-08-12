import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationAnchorWire, PersistedThreadMessageWire } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileThreadStore, recoverInterruptedTurns } from "./file-thread-store";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-threads-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  dirs.length = 0;
});

const ANCHOR: ConversationAnchorWire = {
  kind: "range",
  label: "src/rate/bucket.ts:44-47",
  key: "range|src/rate/bucket.ts|additions|44|47",
  side: "additions",
};

const you = (id: string, body: string): PersistedThreadMessageWire => ({
  id,
  author: "you",
  body,
});
const streaming = (id: string): PersistedThreadMessageWire => ({
  id,
  author: "harness",
  body: "",
  status: "streaming",
});
const complete = (id: string, body: string): PersistedThreadMessageWire => ({
  id,
  author: "harness",
  model: "Orchestrator · Claude",
  body,
});

describe("FileThreadStore — persistence + round-trip (#251)", () => {
  it("returns no threads for an absent review file (fail-safe)", () => {
    expect(new FileThreadStore(tmpDir()).loadThreads("r")).toEqual([]);
  });

  it("a thread and its completed messages survive a fresh store over the same dir (a restart)", () => {
    const dir = tmpDir();
    const store = new FileThreadStore(dir);
    store.upsertThread("r", {
      threadId: "th",
      anchor: ANCHOR,
      harnessVersionAtCreation: "cc 1.2.3",
    });
    store.putMessage("r", "th", you("m0", "why fail open?"));
    store.putMessage("r", "th", complete("m1", "because the plan says so"));
    // A brand-new store instance over the same directory sees it — durability past the process.
    const reloaded = new FileThreadStore(dir).loadThreads("r");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.threadId).toBe("th");
    expect(reloaded[0]?.harnessVersionAtCreation).toBe("cc 1.2.3");
    expect(reloaded[0]?.messages.map((message) => message.body)).toEqual([
      "why fail open?",
      "because the plan says so",
    ]);
  });

  it("putMessage REPLACES a streaming placeholder by id with its durable completion", () => {
    const dir = tmpDir();
    const store = new FileThreadStore(dir);
    store.upsertThread("r", { threadId: "th", anchor: ANCHOR });
    store.putMessage("r", "th", streaming("m1"));
    store.putMessage("r", "th", complete("m1", "the whole answer"));
    const messages = new FileThreadStore(dir).loadThreads("r")[0]?.messages ?? [];
    // One message (replaced, not duplicated), now complete with a body.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBeUndefined();
    expect(messages[0]?.body).toBe("the whole answer");
  });
});

describe("FileThreadStore — the crash-recovery transform (criterion 3, #251)", () => {
  it("a turn left STREAMING at process exit reads back as INTERRUPTED, never complete, never streaming", () => {
    // The killed-mid-stream case: a streaming placeholder was persisted and the process
    // died before completing. A fresh store (a new process) must surface it interrupted.
    // RED-proof: make loadThreads skip recoverInterruptedTurns and this reads "streaming".
    const dir = tmpDir();
    const store = new FileThreadStore(dir);
    store.upsertThread("r", { threadId: "th", anchor: ANCHOR });
    store.putMessage("r", "th", you("m0", "why?"));
    store.putMessage("r", "th", streaming("m1"));
    const recovered = new FileThreadStore(dir).loadThreads("r")[0]?.messages ?? [];
    const harness = recovered.find((message) => message.author === "harness");
    expect(harness?.status).toBe("interrupted");
    expect(harness?.status).not.toBe("complete");
    // No fabricated answer — the interrupted turn carries the (empty) streaming body.
    expect(harness?.body).toBe("");
  });

  it("recoverInterruptedTurns is pure and only touches streaming messages", () => {
    const before = {
      threadId: "th",
      anchor: ANCHOR,
      messages: [you("m0", "q"), streaming("m1"), complete("m2", "done")],
    };
    const after = recoverInterruptedTurns(before);
    expect(after.messages.map((message) => message.status)).toEqual([
      undefined,
      "interrupted",
      undefined,
    ]);
    // The complete message and the "you" message are untouched.
    expect(after.messages[2]?.body).toBe("done");
  });

  it("a thread with only completed messages is returned unchanged (no needless copy)", () => {
    const thread = {
      threadId: "th",
      anchor: ANCHOR,
      messages: [complete("m1", "answer")],
    };
    expect(recoverInterruptedTurns(thread)).toBe(thread);
  });
});

describe("FileThreadStore — malformed files are never clobbered (Rule 75)", () => {
  it("a malformed file reads as no threads and upsert REFUSES to overwrite it", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, `${encodeURIComponent("r")}.json`), "{ not valid json");
    const store = new FileThreadStore(dir);
    expect(store.loadThreads("r")).toEqual([]);
    expect(() => store.upsertThread("r", { threadId: "th", anchor: ANCHOR })).toThrow(/malformed/);
    // The bytes are left for a human to recover.
    expect(readFileSync(join(dir, `${encodeURIComponent("r")}.json`), "utf8")).toBe(
      "{ not valid json",
    );
  });
});
