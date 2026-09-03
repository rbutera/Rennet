import { describe, expect, it, vi } from "vitest";
import type { OrchestrationThread, OrchestrationThreadStreamItem } from "./client";
import { watchSeatThread } from "./seat-progress";

// The daemon holds ONE subscription per running seat and publishes a throttled line into
// its lane. Driven with a stub client and a fake clock; the projection itself is proven
// by latest-event.test.ts and the wire by client.test.ts.

const ISO = (ms: number) => new Date(ms).toISOString();

const threadAt = (ms: number, detail: string): OrchestrationThread =>
  ({
    latestTurn: { turnId: "turn-1" },
    activities: [
      {
        tone: "tool",
        kind: "tool.updated",
        summary: "Tool",
        payload: { detail },
        turnId: "turn-1",
        createdAt: ISO(ms),
      },
    ],
    messages: [],
  }) as unknown as OrchestrationThread;

/** A subscription the test pushes events into, one at a time. */
function pushableStream() {
  const queue: OrchestrationThreadStreamItem[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let returned = false;
  return {
    get returned() {
      return returned;
    },
    push(item: OrchestrationThreadStreamItem) {
      queue.push(item);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<OrchestrationThreadStreamItem>> {
            for (;;) {
              const item = queue.shift();
              if (item !== undefined) return { value: item, done: false };
              if (closed) return { value: undefined, done: true };
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
          async return(): Promise<IteratorResult<OrchestrationThreadStreamItem>> {
            returned = true;
            return { value: undefined, done: true };
          },
        };
      },
    } as AsyncIterable<OrchestrationThreadStreamItem>,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Poll a real-timer condition; the trailing-edge test needs wall clock, not a fake one. */
async function waitUntil(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("watchSeatThread", () => {
  it("publishes the projected line from the thread's first snapshot", async () => {
    const stream = pushableStream();
    const published: string[] = [];
    const clock = 1_000;
    const watch = watchSeatThread({
      client: {
        subscribeThread: () => stream.iterable,
        readThread: vi.fn(async () => threadAt(clock, "Bash: git log")),
      },
      threadId: "t1",
      repoRoot: "/repo",
      publish: (latest) => published.push(latest.text),
      now: () => clock,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(1_000, 'Read: {"file_path":"/repo/src/a.ts"}') },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["reading src/a.ts"]);
    watch.stop();
  });

  it("publishes at most four times a second, however many events arrive", async () => {
    const stream = pushableStream();
    const published: string[] = [];
    let clock = 1_000;
    const readThread = vi.fn(async () => threadAt(clock, `Bash: step-${clock}`));
    const watch = watchSeatThread({
      client: { subscribeThread: () => stream.iterable, readThread },
      threadId: "t1",
      publish: (latest) => published.push(latest.text),
      now: () => clock,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(1_000, "Bash: step-1000") },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["running step-1000"]);

    // Twenty events inside one 250 ms window: none of them re-reads or publishes NOW —
    // they are deferred to a trailing read, not dropped. What that trailing read produces
    // when no further event arrives has its own test below; this one is about the rate.
    for (let i = 0; i < 20; i += 1) {
      clock += 10;
      stream.push({
        kind: "event",
        event: { type: "item.updated" },
      } as unknown as OrchestrationThreadStreamItem);
      await settle();
    }
    expect(published).toHaveLength(1);
    expect(readThread).not.toHaveBeenCalled();

    // Past the window, the next event does re-read and publish — exactly once.
    clock += 300;
    stream.push({
      kind: "event",
      event: { type: "item.updated" },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["running step-1000", `running step-${clock}`]);
    expect(readThread).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("reports a publisher that throws instead of letting the timer crash the daemon", async () => {
    const stream = pushableStream();
    const errors: unknown[] = [];
    let clock = 1_000;
    const watch = watchSeatThread({
      client: {
        subscribeThread: () => stream.iterable,
        readThread: vi.fn(async () => threadAt(clock, `Bash: step-${clock}`)),
      },
      threadId: "t1",
      publish: () => {
        throw new Error("lane store refused the line");
      },
      onError: (error) => errors.push(error),
      now: () => clock,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(1_000, "Bash: git log") },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
      "lane store refused the line",
    ]);
    // The watch is still alive after the throw: a later event still tries to publish.
    clock += 1_000;
    stream.push({
      kind: "event",
      event: { type: "item.updated" },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(errors).toHaveLength(2);
    watch.stop();
  });

  it("stops publishing and drops the subscription when the lane settles", async () => {
    const stream = pushableStream();
    const published: string[] = [];
    let clock = 1_000;
    const watch = watchSeatThread({
      client: {
        subscribeThread: () => stream.iterable,
        readThread: vi.fn(async () => threadAt(clock, "Bash: later")),
      },
      threadId: "t1",
      publish: (latest) => published.push(latest.text),
      now: () => clock,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(1_000, "Bash: first") },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["running first"]);

    watch.stop();
    await settle();
    expect(stream.returned).toBe(true);

    clock += 5_000;
    stream.push({
      kind: "event",
      event: { type: "item.updated" },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["running first"]);
  });

  // ── The trailing edge (review finding 5) ─────────────────────────────────
  //
  // The throttle used to DROP every event inside its window, so the last state of a busy
  // window reached the lane only when a later event happened to arrive. A seat that goes
  // quiet right after its busiest moment showed a line from the middle of it, forever.

  it("publishes the last state of a busy window when NO further event arrives", async () => {
    // What is under test is the TIMER, so the timers and the clock are faked together and
    // advanced by hand; the microtask flushes (`settle`) stay real. On a real clock this
    // test flaked twice on CI (2026-09-03): a starved runner spent more than the 30 ms
    // window inside the first flush, the event then landed outside the window and was
    // read at once, and "deferred, not served immediately" was false for that reason.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const stream = pushableStream();
    const published: string[] = [];
    let detail = "Bash: step-1";
    const readThread = vi.fn(async () => threadAt(Date.now(), detail));
    const watch = watchSeatThread({
      client: { subscribeThread: () => stream.iterable, readThread },
      threadId: "t1",
      publish: (latest) => published.push(latest.text),
      minIntervalMs: 30,
      idleTickMs: 10_000,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(Date.now(), "Bash: step-1") },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["running step-1"]);

    // ONE event inside the window, and then nothing ever again.
    detail = "Bash: step-final";
    stream.push({
      kind: "event",
      event: { type: "item.updated" },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    // Deferred, not served immediately — otherwise this proves nothing about the trailing
    // read, only that a read happened.
    expect(readThread).not.toHaveBeenCalled();

    // Just short of the window's end: still deferred. Past it: the one trailing read.
    await vi.advanceTimersByTimeAsync(29);
    await settle();
    expect(readThread).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    expect(published).toEqual(["running step-1", "running step-final"]);
    expect(readThread).toHaveBeenCalledTimes(1);
    watch.stop();
    vi.useRealTimers();
  });

  it("does not re-read the thread for events that keep saying the same thing", async () => {
    // A re-read that produces the SAME line publishes nothing, and the read throttle used
    // to be keyed on the PUBLISH time — so a run of identical events re-read the thread
    // over RPC on every single one, forever, and nothing on screen ever changed.
    const stream = pushableStream();
    const published: string[] = [];
    let clock = 1_000;
    const readThread = vi.fn(async () => threadAt(clock, "Bash: same"));
    const watch = watchSeatThread({
      client: { subscribeThread: () => stream.iterable, readThread },
      threadId: "t1",
      publish: (latest) => published.push(latest.text),
      now: () => clock,
      idleTickMs: 10_000,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(1_000, "Bash: same") },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["running same"]);

    // Past the window: one read, and no publication because the line is unchanged.
    clock += 300;
    stream.push({
      kind: "event",
      event: { type: "item.updated" },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);

    // Ten more events inside the NEXT window. Keyed on the publish time these all re-read,
    // because no publication ever moved it.
    for (let i = 0; i < 10; i += 1) {
      clock += 10;
      stream.push({
        kind: "event",
        event: { type: "item.updated" },
      } as unknown as OrchestrationThreadStreamItem);
      await settle();
    }
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);
    watch.stop();
  });

  it("an idle lane publishes at most once every ten seconds", async () => {
    // Review finding 7. A lane's live line is republished by re-sending the WHOLE
    // `SessionPreparation` snapshot, and "quiet for N s" at one-second resolution is a new
    // string every second — five idle lanes pushed five snapshots a second, for the whole
    // generation, to move a digit nobody reads that fast.
    const stream = pushableStream();
    const published: string[] = [];
    let clock = 100_000;
    const watch = watchSeatThread({
      client: {
        subscribeThread: () => stream.iterable,
        readThread: vi.fn(async () => threadAt(0, "Bash: git log")),
      },
      threadId: "t1",
      publish: (latest) => published.push(latest.text),
      now: () => clock,
      // A fast idle tick: the point is that the CLOCK, not the tick rate, decides how often
      // an idle line is news. At one-second resolution this would publish on every tick.
      idleTickMs: 5,
    });
    stream.push({
      kind: "snapshot",
      snapshot: { thread: threadAt(80_000, "Bash: git log") },
    } as unknown as OrchestrationThreadStreamItem);
    await settle();
    expect(published).toEqual(["quiet for 20 s"]);

    // Nine more seconds of quiet, with the tick firing throughout: nothing new is said.
    for (let second = 1; second <= 9; second += 1) {
      clock += 1_000;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(published).toEqual(["quiet for 20 s"]);

    // The tenth second crosses the step, and the line does move — a bucket that never
    // changed would be a frozen line, which is the other half of the same lie.
    clock += 1_000;
    await waitUntil(() => published.length === 2);
    expect(published).toEqual(["quiet for 20 s", "quiet for 30 s"]);
    watch.stop();
  });

  it("survives a subscription that throws, and reports it without failing the seat", async () => {
    const onError = vi.fn();
    const watch = watchSeatThread({
      client: {
        subscribeThread: () => {
          throw new Error("socket closed");
        },
        readThread: vi.fn(),
      },
      threadId: "t1",
      publish: () => undefined,
      onError,
    });
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
