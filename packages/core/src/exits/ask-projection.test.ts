import type { AskEventBody, AskProjection, StagedAsk } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { applyAskEvent, emptyAskProjection, foldAsks, receiptFor } from "./ask-projection";

const ask = (id: string, over: Partial<StagedAsk> = {}): StagedAsk => ({
  id,
  anchor: `src/x.ts:${id}`,
  type: "request-change",
  body: `body ${id}`,
  ...over,
});

/** A prior with one of everything, so inverse paths that read prior state fire. */
function richPrior(): AskProjection {
  return foldAsks([
    { kind: "stage", ask: ask("a1") },
    { kind: "stage", ask: ask("a2", { type: "comment" }) },
    {
      kind: "finding-dismiss",
      finding: { generation: "gen-1", boardId: "board:flagged:1", findingId: "f-1" },
    },
    { kind: "retire", id: "a2", reason: "dropped it" },
    {
      kind: "quote-open",
      threadId: "t1",
      thread: { anchor: "quoted span", messages: [{ author: "user", text: "hi" }] },
    },
    { kind: "line-comment-set", path: "src/x.ts", line: 10, body: "line note" },
    { kind: "verdict-override-set", verdict: "COMMENT" },
  ]);
}

describe("foldAsks — every event folds", () => {
  it("stage adds to the living set, keyed by ask id", () => {
    const p = foldAsks([{ kind: "stage", ask: ask("a1") }]);
    expect(p.stagedAsks).toEqual({ a1: ask("a1") });
  });

  it("unstage removes without a ledger entry", () => {
    const p = foldAsks([
      { kind: "stage", ask: ask("a1") },
      { kind: "unstage", id: "a1" },
    ]);
    expect(p).toEqual(emptyAskProjection());
  });

  it("dismisses and restores a board-attempt-scoped finding without changing board bytes", () => {
    const finding = { generation: "gen-1", boardId: "board:flagged:1", findingId: "f-1" };
    const dismissed = foldAsks([{ kind: "finding-dismiss", finding }]);
    expect(dismissed.findingDispositions).toEqual({
      '["gen-1","board:flagged:1","f-1"]': { finding, disposition: "dismissed" },
    });
    expect(applyAskEvent(dismissed, { kind: "finding-restore", finding })).toEqual(
      emptyAskProjection(),
    );
  });

  it("edit replaces only the body of a staged ask", () => {
    const p = foldAsks([
      { kind: "stage", ask: ask("a1") },
      { kind: "edit", id: "a1", body: "new" },
    ]);
    expect(p.stagedAsks.a1).toEqual(ask("a1", { body: "new" }));
  });

  it("retire moves the whole ask into the retired ledger with its reason", () => {
    const p = foldAsks([
      { kind: "stage", ask: ask("a1") },
      { kind: "retire", id: "a1", reason: "why" },
    ]);
    expect(p.stagedAsks).toEqual({});
    expect(p.retired).toEqual({ a1: { ask: ask("a1"), reason: "why" } });
  });

  it("restore re-stages the whole ask and clears the ledger entry", () => {
    const p = foldAsks([
      { kind: "stage", ask: ask("a1") },
      { kind: "retire", id: "a1", reason: "why" },
      { kind: "restore", id: "a1" },
    ]);
    expect(p.stagedAsks).toEqual({ a1: ask("a1") });
    expect(p.retired).toEqual({});
  });

  it("quote-open / reply / close manage the thread map", () => {
    const opened = foldAsks([
      {
        kind: "quote-open",
        threadId: "t1",
        thread: { anchor: "span", messages: [{ author: "user", text: "a" }] },
      },
    ]);
    expect(opened.quoteThreads.t1?.messages).toEqual([{ author: "user", text: "a" }]);
    const replied = applyAskEvent(opened, {
      kind: "quote-reply",
      threadId: "t1",
      messages: [
        { author: "user", text: "a" },
        { author: "orchestrator", text: "b" },
      ],
    });
    expect(replied.quoteThreads.t1?.messages).toHaveLength(2);
    const closed = applyAskEvent(replied, { kind: "quote-close", threadId: "t1" });
    expect(closed.quoteThreads).toEqual({});
  });

  it("verdict override set then clear", () => {
    const set = foldAsks([{ kind: "verdict-override-set", verdict: "APPROVE" }]);
    expect(set.verdictOverride).toBe("APPROVE");
    expect(applyAskEvent(set, { kind: "verdict-override-clear" }).verdictOverride).toBeNull();
  });

  it("line comment set then clear drops the whole path once empty", () => {
    const set = foldAsks([{ kind: "line-comment-set", path: "p", line: 3, body: "note" }]);
    expect(set.lineComments).toEqual({ p: { "3": "note" } });
    const cleared = applyAskEvent(set, { kind: "line-comment-clear", path: "p", line: 3 });
    expect(cleared.lineComments).toEqual({});
  });
});

describe("applyAskEvent — no-op safety on absent targets", () => {
  const empty = emptyAskProjection();
  it("edit / retire an unstaged ask is a no-op", () => {
    expect(applyAskEvent(empty, { kind: "edit", id: "ghost", body: "x" })).toEqual(empty);
    expect(applyAskEvent(empty, { kind: "retire", id: "ghost", reason: "x" })).toEqual(empty);
  });
  it("reply to / close an absent thread is a no-op", () => {
    expect(applyAskEvent(empty, { kind: "quote-reply", threadId: "ghost", messages: [] })).toEqual(
      empty,
    );
    expect(applyAskEvent(empty, { kind: "quote-close", threadId: "ghost" })).toEqual(empty);
  });
  it("restore an absent ledger entry is a no-op", () => {
    expect(applyAskEvent(empty, { kind: "restore", id: "ghost" })).toEqual(empty);
  });
});

describe("receipt-is-undo — applying a receipt returns the exact prior projection", () => {
  // Each case: an event applied to a prior, then its receipt, must deep-equal prior.
  const cases: { name: string; prior: () => AskProjection; event: AskEventBody }[] = [
    { name: "stage", prior: richPrior, event: { kind: "stage", ask: ask("new") } },
    // DUPLICATE-IDENTITY overwrite (P1 finding 6): staging over an existing id must
    // round-trip to RESTORE the prior ask, not delete it. Before the fix the receipt was
    // always `unstage`, so applying it after a re-stage of an existing id removed the
    // ORIGINAL ask — receipt-is-undo lied on any duplicate identity.
    {
      name: "stage OVER an existing id (duplicate identity → restore prior)",
      prior: richPrior,
      event: { kind: "stage", ask: ask("a1", { body: "overwritten body", type: "comment" }) },
    },
    {
      name: "quote-open OVER an existing thread id (duplicate identity → restore prior)",
      prior: richPrior,
      event: {
        kind: "quote-open",
        threadId: "t1",
        thread: { anchor: "different span", messages: [{ author: "orchestrator", text: "new" }] },
      },
    },
    { name: "unstage (existing)", prior: richPrior, event: { kind: "unstage", id: "a1" } },
    {
      name: "finding dismiss (new)",
      prior: richPrior,
      event: {
        kind: "finding-dismiss",
        finding: { generation: "gen-1", boardId: "board:flagged:1", findingId: "f-2" },
      },
    },
    {
      name: "finding dismiss (existing)",
      prior: richPrior,
      event: {
        kind: "finding-dismiss",
        finding: { generation: "gen-1", boardId: "board:flagged:1", findingId: "f-1" },
      },
    },
    {
      name: "finding restore (existing)",
      prior: richPrior,
      event: {
        kind: "finding-restore",
        finding: { generation: "gen-1", boardId: "board:flagged:1", findingId: "f-1" },
      },
    },
    {
      name: "edit (existing)",
      prior: richPrior,
      event: { kind: "edit", id: "a1", body: "edited" },
    },
    {
      name: "retire (existing)",
      prior: richPrior,
      event: { kind: "retire", id: "a1", reason: "gone" },
    },
    { name: "restore (from ledger)", prior: richPrior, event: { kind: "restore", id: "a2" } },
    {
      name: "quote-open (new)",
      prior: richPrior,
      event: {
        kind: "quote-open",
        threadId: "t2",
        thread: { anchor: "s", messages: [{ author: "user", text: "x" }] },
      },
    },
    {
      name: "quote-reply (append to existing)",
      prior: richPrior,
      event: {
        kind: "quote-reply",
        threadId: "t1",
        messages: [
          { author: "user", text: "hi" },
          { author: "orchestrator", text: "reply" },
        ],
      },
    },
    {
      name: "quote-close (existing)",
      prior: richPrior,
      event: { kind: "quote-close", threadId: "t1" },
    },
    {
      name: "verdict set over existing",
      prior: richPrior,
      event: { kind: "verdict-override-set", verdict: "APPROVE" },
    },
    {
      name: "verdict set over null",
      prior: emptyAskProjection,
      event: { kind: "verdict-override-set", verdict: "REQUEST_CHANGES" },
    },
    {
      name: "verdict clear over existing",
      prior: richPrior,
      event: { kind: "verdict-override-clear" },
    },
    {
      name: "line set over existing",
      prior: richPrior,
      event: { kind: "line-comment-set", path: "src/x.ts", line: 10, body: "changed" },
    },
    {
      name: "line set on fresh path",
      prior: richPrior,
      event: { kind: "line-comment-set", path: "fresh.ts", line: 1, body: "new" },
    },
    {
      name: "line clear over existing",
      prior: richPrior,
      event: { kind: "line-comment-clear", path: "src/x.ts", line: 10 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const prior = c.prior();
      const after = applyAskEvent(prior, c.event);
      const undone = applyAskEvent(after, receiptFor(c.event, prior));
      expect(undone).toEqual(prior);
    });
  }

  it("stage's receipt withdraws from the living set with no ledger residue (a toggle-off)", () => {
    const prior = emptyAskProjection();
    const after = applyAskEvent(prior, { kind: "stage", ask: ask("a1") });
    expect(after.stagedAsks.a1).toBeDefined();
    const undone = applyAskEvent(after, receiptFor({ kind: "stage", ask: ask("a1") }, prior));
    expect(undone.stagedAsks).toEqual({});
    expect(undone.retired).toEqual({});
  });
});
