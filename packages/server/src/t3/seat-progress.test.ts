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

    // Twenty events inside one 250 ms window: none of them re-reads or publishes.
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
