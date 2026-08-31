// @vitest-environment happy-dom
//
// The board's refresh poll, driven on a fake clock (perf audit 2026-08-31, §1 H1). The poll
// exists because the daemon has no board-arrival push; the defect was that its only stop
// condition was "every lens settled", which a review whose Noise lens legitimately drafts
// nothing never reaches — five loopback reads every five seconds for as long as the board
// is open. `gen0` is exactly that shape: the fixture set carries one Design board there and
// nothing for the other four lenses, so `lensReadsSettled` is false forever.
//
// The tests count `board.read` invocations at the bridge, so they measure the poll's real
// effect on the wire rather than an internal counter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { act, cleanup, mount } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import { LensBoardView } from "./board-view";

/** Advance the fake clock and let React flush every update the poll schedules. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Mount the never-settling generation and return a live count of `board.read` reads. */
async function mountUnsettledBoard() {
  let reads = 0;
  const bridge = new MemoryBridge({
    "board.read": (input) => {
      reads += 1;
      return fixtureBoardRead(input);
    },
  });
  mount(
    <BridgeProvider bridge={bridge}>
      <LensBoardView reviewId="rev-1" generation="gen0" lens="design" />
    </BridgeProvider>,
  );
  // Let the five first reads resolve, so the baseline is the poll's doing and nothing else.
  await tick(0);
  await tick(0);
  return () => reads;
}

describe("board refresh poll (perf audit §1 H1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setHidden(false);
  });

  it("polls an unsettled board, then stops once its budget of unchanged reads is spent", async () => {
    const reads = await mountUnsettledBoard();
    const mounted = reads();
    expect(mounted).toBeGreaterThan(0);

    // Five minutes in: still live, because a lens can legitimately take minutes to land.
    await tick(5 * 60_000);
    const polling = reads();
    expect(polling).toBeGreaterThan(mounted);

    // Ten minutes of reads that learned nothing (no lens ever changed status) spends the
    // budget — and it was still alive after minute five, so the window is minutes wide, not
    // a token gesture. Half an hour later the board has stopped asking.
    await tick(10 * 60_000);
    const exhausted = reads();
    expect(exhausted).toBeGreaterThan(polling);
    await tick(30 * 60_000);
    expect(reads()).toBe(exhausted);
  });

  it("keeps polling past the budget when a lens lands late — the arrival restarts it", async () => {
    // Nothing has been drafted yet: every lens reads back null, so the board is unsettled
    // from mount and the budget starts running immediately.
    let reads = 0;
    let drafted = false;
    const bridge = new MemoryBridge({
      "board.read": (input) => {
        reads += 1;
        return drafted ? fixtureBoardRead(input) : { board: null };
      },
    });
    mount(
      <BridgeProvider bridge={bridge}>
        <LensBoardView reviewId="rev-1" generation="gen0" lens="design" />
      </BridgeProvider>,
    );
    await tick(0);
    await tick(0);

    // Eight minutes of silence — inside the budget, but most of it spent.
    await tick(8 * 60_000);
    // The Design board lands. The next poll observes it, which restarts the window.
    drafted = true;
    await tick(60_000);

    // Minute twelve: the budget the poll held at mount ran out two minutes ago. Baseline
    // AFTER that expiry, or the last minute of the original window would satisfy the
    // assertion below and the restart would go unproven.
    await tick(3 * 60_000);
    const afterOriginalBudget = reads;

    // Minute sixteen, still reading: the arrival bought a fresh window, so a review whose
    // lenses land slowly one after another is never cut off mid-round.
    await tick(4 * 60_000);
    expect(reads).toBeGreaterThan(afterOriginalBudget);
  });

  it("does not poll while the document is hidden, and reads again on return", async () => {
    const reads = await mountUnsettledBoard();
    const mounted = reads();

    setHidden(true);
    await tick(60_000);
    expect(reads()).toBe(mounted);

    // Coming back reads immediately rather than waiting out a background-throttled tick.
    setHidden(false);
    await tick(0);
    expect(reads()).toBeGreaterThan(mounted);
  });
});
