// @vitest-environment happy-dom
//
// The board's refresh poll, driven on a fake clock (perf audit 2026-08-31, §1 H1). The poll
// exists because the daemon has no board-arrival push; the defect was that its only stop
// condition was "every lens settled", which a review whose Noise lens legitimately drafts
// nothing never reaches — five loopback reads every five seconds for as long as the board
// is open. `gen0` is exactly that shape: the fixture set carries one Design board there and
// nothing for the other four lenses, so `lensReadsSettled` is false forever.
//
// The poll THROTTLES, it does not stop: past its budget of learned-nothing reads it drops to
// one read a minute, because for a PR-snapshot review this poll is the only way a board ever
// reaches the screen (the focus-invalidate path is gated on `fromWorkingTree`). So these tests
// measure CADENCE, not liveness — an assertion that the poll is "still reading" is satisfied by
// both the fast and the slow window, and would pass on a poll that never sped back up.
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

/** Mount a never-settling generation and return a live count of `board.read` reads.
 *  `drafted()` decides whether the Design lens answers with its fixture board or nothing. */
async function mountBoard(drafted: () => boolean = () => true) {
  let reads = 0;
  const bridge = new MemoryBridge({
    "board.read": (input) => {
      reads += 1;
      return drafted() ? fixtureBoardRead(input) : { board: null };
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
  // Each test advances a fake clock through fifteen to thirty minutes of poll ticks, with a
  // React flush per tick. That is under half a second here and over the default five-second
  // budget on a two-core CI runner sharing the box with the server suites (three consecutive
  // runs on 2026-09-03 timed out the first test, which then starved the other four of every
  // read). The budget is wall-clock only; the fake clock is what the assertions measure.
  vi.setConfig({ testTimeout: 30_000 });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setHidden(false);
  });

  it("polls an unsettled board fast, then SLOWS to about a twelfth once its budget is spent", async () => {
    const reads = await mountBoard();
    const mounted = reads();
    expect(mounted).toBeGreaterThan(0);

    // Minutes 0–5, well inside the budget: the yardstick for "fast". Still live at minute
    // five matters on its own — a lens can legitimately take minutes to land.
    await tick(5 * 60_000);
    const fastWindow = reads() - mounted;
    expect(fastWindow).toBeGreaterThan(0);

    // Minute fifteen: ten minutes of reads that learned nothing (no lens ever changed status)
    // spent the budget five minutes ago.
    await tick(10 * 60_000);
    const exhausted = reads();

    // Minutes 15–20, the SAME width of window as the yardstick. The poll is still reading —
    // it must be, or a board landing now would never appear — but at roughly a twelfth of the
    // rate. Both halves are load-bearing: zero growth means it stopped, growth near the
    // yardstick means it never slowed.
    await tick(5 * 60_000);
    const slowWindow = reads() - exhausted;
    expect(slowWindow).toBeGreaterThan(0);
    expect(slowWindow).toBeLessThan(fastWindow / 6);
  });

  it("discovers a board that first arrives AFTER the budget is spent", async () => {
    // The defect this pins: when the poll STOPPED at its budget, a PR-snapshot review had no
    // way back. Its focus-invalidate escape is gated on `fromWorkingTree`
    // (app/review-workspace-route.tsx), so a board drafted after ten quiet minutes stayed
    // invisible until the reviewer remounted the workspace. Asserted on the rendered document,
    // not on the read count: what failed was that the board never appeared.
    let drafted = false;
    await mountBoard(() => drafted);

    // Twelve minutes of silence — two minutes past the budget, so the fast window is gone.
    await tick(12 * 60_000);
    expect(document.querySelector('[data-lens="design"]')).toBeNull();

    // The Design board lands. One slow tick later it is on screen, with no remount.
    drafted = true;
    await tick(60_000);
    await tick(0);
    expect(document.querySelector('[data-lens="design"]')).not.toBeNull();
  });

  it("restores the FAST cadence when a lens lands late — the arrival restarts the budget", async () => {
    // Nothing has been drafted yet: every lens reads back null, so the board is unsettled
    // from mount and the budget starts running immediately.
    let drafted = false;
    const reads = await mountBoard(() => drafted);
    const mounted = reads();

    // Minutes 0–2, inside the original fast window: the yardstick.
    await tick(2 * 60_000);
    const fastWindow = reads() - mounted;
    expect(fastWindow).toBeGreaterThan(0);

    // Minute eight — inside the budget, but most of it spent. The Design board lands, and the
    // next poll observes the status change, which restarts the window.
    await tick(6 * 60_000);
    drafted = true;
    await tick(60_000);

    // Minute twelve: the budget the poll held at mount ran out two minutes ago. Baseline
    // AFTER that expiry, or the last minute of the original window would satisfy the
    // assertion below and the restart would go unproven.
    await tick(3 * 60_000);
    const afterOriginalBudget = reads();

    // Minutes 12–14, the same width as the yardstick: reading at the FAST rate again. A
    // merely-still-alive poll now reads a twelfth of this, so "greater than zero" would NOT
    // catch a lost restart — the comparison against the yardstick is what does.
    await tick(2 * 60_000);
    expect(reads() - afterOriginalBudget).toBeGreaterThan(fastWindow / 2);
  });

  it("does not poll while the document is hidden, and reads again on return", async () => {
    const reads = await mountBoard();
    const mounted = reads();

    setHidden(true);
    await tick(60_000);
    expect(reads()).toBe(mounted);

    // Coming back reads immediately rather than waiting out a background-throttled tick.
    setHidden(false);
    await tick(0);
    expect(reads()).toBeGreaterThan(mounted);
  });

  it("charges the poll budget nothing for returning to the window", async () => {
    const reads = await mountBoard();
    const mounted = reads();

    // Minutes 0–2: the fast yardstick again.
    await tick(2 * 60_000);
    const fastWindow = reads() - mounted;
    expect(fastWindow).toBeGreaterThan(0);

    // Alt-tab away and back 130 times — more returns than the whole budget of ticks. The old
    // handler routed the return through `tick`, so each one spent budget as well as reading,
    // and this loop alone would have exhausted the fast window.
    await act(async () => {
      for (let i = 0; i < 130; i += 1) {
        setHidden(true);
        setHidden(false);
      }
    });
    const afterTabbing = reads();

    // Minutes 2–4, same window width: still fast, so the returns cost the budget nothing.
    await tick(2 * 60_000);
    expect(reads() - afterTabbing).toBeGreaterThan(fastWindow / 2);
  });
});
