import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import { applyAskEvent } from "@rennet/core";
import type { AskEventBody, AskProjection } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { askHandlers } from "./dispatch/ask";

// The dispatch-layer half of the durable-asks write path (B11 cluster 2, task 2.3). Cluster 1
// proved the pure fold + receipt-is-undo; this proves the HANDLERS are the sole writers: every
// `ask.*` command appends EXACTLY one event and returns a receipt that inverts the write — and
// that the projection survives a process restart (a fresh store over the same log dir), the
// E2E's reload-survival core in miniature.

const SID = "session-under-test";

/** Build the ask handlers over a real store in a fresh temp dir, plus an emit spy. */
function harness() {
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-ask-dispatch-")));
  const broadcastAskProjection = vi.fn<(sessionId: string, p: AskProjection) => void>();
  const rt = createDispatchRuntime({
    askLog: store,
    broadcastAskProjection,
  } as unknown as DispatchDeps);
  return { store, broadcastAskProjection, handlers: askHandlers(rt) };
}

type Handlers = ReturnType<typeof askHandlers>;

/**
 * Invoke one write command and assert the two write-path invariants: exactly one event landed,
 * and the returned receipt is a true inverse (applying it to the post-write projection restores
 * the pre-write one). Pure `applyAskEvent` probes the inverse so the on-disk sequence stays a
 * clean, chronological log the next scripted step continues from.
 */
async function writeAndAssertReversible(
  store: AskLogStore,
  handlers: Handlers,
  command: keyof Handlers,
  input: Record<string, unknown>,
): Promise<void> {
  const before = store.readProjection(SID);
  const beforeCount = store.read(SID).length;
  const result = (await handlers[command]({ sessionId: SID, ...input })) as {
    receipt: AskEventBody;
  };

  // Exactly one event appended — the sole-writer guarantee (no double-write, no missing write).
  expect(store.read(SID).length).toBe(beforeCount + 1);
  // Receipt-is-undo at the dispatch layer: the handler's receipt inverts its own write.
  expect(applyAskEvent(store.readProjection(SID), result.receipt)).toEqual(before);
}

describe("ask.* dispatch — the sole write path (B11 2.3)", () => {
  it("each write command appends exactly one event and returns a reversing receipt", async () => {
    const { store, handlers } = harness();
    const ask = { id: "a1", anchor: "src/x.ts:10", type: "request-change" as const, body: "fix" };

    await writeAndAssertReversible(store, handlers, "ask.stage", { ask });
    await writeAndAssertReversible(store, handlers, "ask.edit", { id: "a1", body: "fix it well" });
    await writeAndAssertReversible(store, handlers, "ask.retire", { id: "a1", reason: "dupe" });
    await writeAndAssertReversible(store, handlers, "ask.restore", { id: "a1" });
    await writeAndAssertReversible(store, handlers, "ask.quoteOpen", {
      threadId: "t1",
      thread: { anchor: "some prose", messages: [] },
    });
    await writeAndAssertReversible(store, handlers, "ask.quoteReply", {
      threadId: "t1",
      author: "user",
      text: "why this?",
    });
    await writeAndAssertReversible(store, handlers, "ask.quoteClose", { threadId: "t1" });
    await writeAndAssertReversible(store, handlers, "ask.setVerdictOverride", {
      verdict: "REQUEST_CHANGES",
    });
    await writeAndAssertReversible(store, handlers, "ask.setVerdictOverride", { verdict: null });
    await writeAndAssertReversible(store, handlers, "ask.setLineComment", {
      path: "src/x.ts",
      line: 10,
      body: "nit",
    });
    await writeAndAssertReversible(store, handlers, "ask.clearLineComment", {
      path: "src/x.ts",
      line: 10,
    });
    await writeAndAssertReversible(store, handlers, "ask.unstage", { id: "a1" });
  });

  it("ask.quoteReply appends to the thread's existing messages", async () => {
    const { store, handlers } = harness();
    await handlers["ask.quoteOpen"]({
      sessionId: SID,
      threadId: "t1",
      thread: { anchor: "prose", messages: [{ author: "user", text: "first" }] },
    });
    await handlers["ask.quoteReply"]({
      sessionId: SID,
      threadId: "t1",
      author: "orchestrator",
      text: "second",
    });
    expect(store.readProjection(SID).quoteThreads.t1?.messages).toEqual([
      { author: "user", text: "first" },
      { author: "orchestrator", text: "second" },
    ]);
  });

  it("emits the fresh projection to live clients on every append (R19), never on a read", async () => {
    const { handlers, broadcastAskProjection } = harness();
    const ask = { id: "a1", anchor: "src/x.ts:10", type: "comment" as const, body: "note" };
    await handlers["ask.stage"]({ sessionId: SID, ask });
    expect(broadcastAskProjection).toHaveBeenCalledTimes(1);
    expect(broadcastAskProjection.mock.calls[0]?.[0]).toBe(SID);
    expect(broadcastAskProjection.mock.calls[0]?.[1].stagedAsks.a1).toEqual(ask);

    // A read is NOT a write — it must not broadcast.
    await handlers["ask.read"]({ sessionId: SID });
    expect(broadcastAskProjection).toHaveBeenCalledTimes(1);
  });

  it("the projection survives a restart: a fresh store over the same log dir reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-ask-reload-"));
    const store = new AskLogStore(dir);
    const rt = createDispatchRuntime({ askLog: store } as unknown as DispatchDeps);
    const handlers = askHandlers(rt);

    // Stage the full spread the E2E exercises: a body ask, a line comment, a quote thread, and a
    // verdict override — every collection in the projection.
    await handlers["ask.stage"]({
      sessionId: SID,
      ask: { id: "a1", anchor: "src/x.ts:10", type: "request-change", body: "fix" },
    });
    await handlers["ask.setLineComment"]({
      sessionId: SID,
      path: "src/x.ts",
      line: 10,
      body: "nit",
    });
    await handlers["ask.quoteOpen"]({
      sessionId: SID,
      threadId: "t1",
      thread: { anchor: "prose", kind: "comment", messages: [{ author: "user", text: "hm" }] },
    });
    await handlers["ask.setVerdictOverride"]({ sessionId: SID, verdict: "APPROVE" });
    const before = store.readProjection(SID);

    // Simulated restart: a brand-new store over the SAME directory, nothing carried in memory.
    // The log on disk is the only survivor.
    const reloaded = new AskLogStore(dir);
    expect(reloaded.readProjection(SID)).toEqual(before);

    // And the reloaded projection is non-vacuous — every collection rehydrated.
    expect(before.stagedAsks.a1).toBeDefined();
    expect(before.lineComments["src/x.ts"]?.["10"]).toBe("nit");
    expect(before.quoteThreads.t1?.messages).toHaveLength(1);
    expect(before.verdictOverride).toBe("APPROVE");
  });

  // ── Ingestion path safety (P2 finding 9 — privacy) ──────────────────────────
  it("REFUSES a code anchor or line-comment path that is not repo-relative (no host-path leak)", async () => {
    const { store, handlers } = harness();
    // An absolute code-anchor path would leak into the R19 projection — refused at ingestion.
    await expect(
      handlers["ask.stage"]({
        sessionId: SID,
        ask: { id: "bad", anchor: "/etc/passwd:10", type: "comment", body: "leak" },
      }),
    ).rejects.toThrow(/repo-relative|unsafe path/i);
    // A traversing line-comment KEY is refused too (it becomes a projection record key).
    await expect(
      handlers["ask.setLineComment"]({ sessionId: SID, path: "../../secret", line: 3, body: "x" }),
    ).rejects.toThrow(/repo-relative|unsafe path/i);
    // Nothing was written — the corrupt/leaky input never entered the durable log.
    expect(store.read(SID)).toHaveLength(0);
  });

  it("still accepts repo-relative code anchors and prose anchors (no false rejection)", async () => {
    const { store, handlers } = harness();
    // A normal code anchor.
    await handlers["ask.stage"]({
      sessionId: SID,
      ask: { id: "ok1", anchor: "packages/server/src/x.ts:42", type: "comment", body: "fine" },
    });
    // A prose anchor (free text, with spaces) is not a path — accepted untouched.
    await handlers["ask.stage"]({
      sessionId: SID,
      ask: { id: "ok2", anchor: "This whole section reads well.", type: "comment", body: "praise" },
    });
    await handlers["ask.setLineComment"]({
      sessionId: SID,
      path: "src/a.ts",
      line: 1,
      body: "nit",
    });
    expect(store.read(SID)).toHaveLength(3);
  });
});
