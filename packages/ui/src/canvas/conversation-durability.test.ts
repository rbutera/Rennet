import { describe, expect, it } from "vitest";
import {
  type CoalescerBook,
  channelBody,
  coalescerKey,
  emptyCoalescerBook,
  flushChannel,
  interruptedTurn,
  isComplete,
  isInterrupted,
  isOrphaned,
  isStreaming,
  lineAnchorKey,
  markOrphaned,
  openThread,
  pushDelta,
  type StreamChannel,
  type ThreadMessage,
} from "./conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Issue #251 — the durability model additions (turn lifecycle, orphaned threads,
// the clock-injected stream coalescer). Pure; no Electron, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

describe("turn lifecycle (#251)", () => {
  it("a message with no status is COMPLETE (every #36 message stays complete)", () => {
    const message: ThreadMessage = { id: "m", author: "harness", model: "Claude", body: "done" };
    expect(isComplete(message)).toBe(true);
    expect(isStreaming(message)).toBe(false);
    expect(isInterrupted(message)).toBe(false);
  });

  it("a streaming message reads streaming, never complete", () => {
    const message: ThreadMessage = { id: "m", author: "harness", body: "par", status: "streaming" };
    expect(isStreaming(message)).toBe(true);
    expect(isComplete(message)).toBe(false);
  });

  it("an interrupted turn carries NO fabricated answer and never reads complete", () => {
    // The whole point of #251: a killed-mid-stream turn is surfaced honestly. If
    // interruptedTurn ever set status "complete" or invented a body, this reddens.
    const turn = interruptedTurn("m", "Claude");
    expect(isInterrupted(turn)).toBe(true);
    expect(isComplete(turn)).toBe(false);
    expect(turn.body).toBe("");
    expect(turn.author).toBe("harness");
  });

  it("an interrupted turn preserves whatever partial text had streamed, still flagged interrupted", () => {
    const turn = interruptedTurn("m", "Claude", "half an ans");
    expect(turn.body).toBe("half an ans");
    expect(isInterrupted(turn)).toBe(true);
    expect(isComplete(turn)).toBe(false);
  });
});

describe("orphaned threads (#251)", () => {
  const anchor = {
    kind: "line" as const,
    label: "src/a.ts:5",
    key: lineAnchorKey("src/a.ts", "additions", 5),
    side: "additions" as const,
  };

  it("a fresh thread is NOT orphaned", () => {
    expect(isOrphaned(openThread("t", anchor))).toBe(false);
  });

  it("markOrphaned flags the thread but leaves the anchor and content UNCHANGED (no re-anchor)", () => {
    // Orphaning surfaces a loss; it must never re-point the thread at other code. If
    // markOrphaned ever rewrote the anchor key, this reddens — the disposition-carry class.
    const before = openThread("t", anchor);
    const after = markOrphaned(before);
    expect(isOrphaned(after)).toBe(true);
    expect(after.anchor.key).toBe(before.anchor.key);
    expect(after.anchor).toEqual(before.anchor);
    expect(after.messages).toBe(before.messages);
  });
});

describe("stream coalescer under an injected clock (#251)", () => {
  const THROTTLE = 50;

  /** Fold a whole delta sequence into a book at the given per-delta timestamps. */
  function foldAll(
    turnId: string,
    channel: StreamChannel,
    deltas: readonly string[],
    times: readonly number[],
  ): { book: CoalescerBook; repaints: number } {
    let book = emptyCoalescerBook();
    let repaints = 0;
    deltas.forEach((delta, i) => {
      const now = times[i] ?? 0;
      const result = pushDelta(book, turnId, channel, delta, now, THROTTLE);
      book = result.book;
      if (result.repaint) repaints += 1;
    });
    return { book, repaints };
  }

  it("the body is a pure concatenation of deltas, independent of the clock", () => {
    const deltas = ["Hel", "lo ", "world"];
    // Fast clock (deltas 1ms apart) vs slow clock (1000ms apart): different repaint
    // cadence, IDENTICAL final body. RED-proof: make pushDelta gate the BODY on `due`
    // (only append when repainting) and the fast-clock body loses its throttled tokens.
    const fast = foldAll("t1", "orchestrator", deltas, [0, 1, 2]);
    const slow = foldAll("t1", "orchestrator", deltas, [0, 1000, 2000]);
    expect(channelBody(fast.book, "t1", "orchestrator")).toBe("Hello world");
    expect(channelBody(slow.book, "t1", "orchestrator")).toBe("Hello world");
    expect(channelBody(fast.book, "t1", "orchestrator")).toBe(
      channelBody(slow.book, "t1", "orchestrator"),
    );
  });

  it("repaint is DUE only once at least throttleMs has elapsed since the last repaint", () => {
    // now=0 (first delta, lastRepaintAt=-Infinity → due), 10, 20 (< 50 → not due), 60 (due).
    let book = emptyCoalescerBook();
    const r0 = pushDelta(book, "t", "orchestrator", "a", 0, THROTTLE);
    book = r0.book;
    const r1 = pushDelta(book, "t", "orchestrator", "b", 10, THROTTLE);
    book = r1.book;
    const r2 = pushDelta(book, "t", "orchestrator", "c", 20, THROTTLE);
    book = r2.book;
    const r3 = pushDelta(book, "t", "orchestrator", "d", 60, THROTTLE);
    expect([r0.repaint, r1.repaint, r2.repaint, r3.repaint]).toEqual([true, false, false, true]);
    // The body accumulated through every delta regardless of repaint.
    expect(r3.body).toBe("abcd");
  });

  it("flushChannel always repaints the full accumulated body (the done/interrupted paint)", () => {
    let book = emptyCoalescerBook();
    book = pushDelta(book, "t", "orchestrator", "one", 0, THROTTLE).book;
    book = pushDelta(book, "t", "orchestrator", "two", 5, THROTTLE).book; // throttled, no repaint
    const flushed = flushChannel(book, "t", "orchestrator", 6);
    expect(flushed.repaint).toBe(true);
    expect(flushed.body).toBe("onetwo");
  });

  it("two channels of the SAME turn accumulate INDEPENDENTLY", () => {
    // RED-proof: change coalescerKey to ignore `channel` (key on turnId alone) and the two
    // bodies collide into one interleaved string — this assertion reddens.
    let book = emptyCoalescerBook();
    book = pushDelta(book, "t", "orchestrator", "ORCH-a ", 0, THROTTLE).book;
    book = pushDelta(book, "t", "codex", "CODEX-a ", 1, THROTTLE).book;
    book = pushDelta(book, "t", "orchestrator", "ORCH-b", 2, THROTTLE).book;
    book = pushDelta(book, "t", "codex", "CODEX-b", 3, THROTTLE).book;
    expect(channelBody(book, "t", "orchestrator")).toBe("ORCH-a ORCH-b");
    expect(channelBody(book, "t", "codex")).toBe("CODEX-a CODEX-b");
  });

  it("the book key is injective across channels", () => {
    expect(coalescerKey("t", "orchestrator")).not.toBe(coalescerKey("t", "codex"));
    // Injective for any turnId contents (JSON-tuple idiom), so a turnId that mimics the
    // other channel's key shape cannot collide.
    expect(coalescerKey('t","codex"', "orchestrator")).not.toBe(coalescerKey("t", "codex"));
  });
});
