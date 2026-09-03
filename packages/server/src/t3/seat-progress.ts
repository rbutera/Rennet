// The live line behind a lens lane (t3-lens-threads 2.3).
//
// While a seat's lane runs, the DAEMON holds one subscription to that seat's thread and
// publishes the projected latest event through the lane. The renderer never subscribes
// per lane: one socket per running seat, dropped the moment the lane settles.
//
// Two costs are bounded on purpose. Thread events do not carry the whole projection, so a
// re-read is an RPC — it is throttled to at most four a second per lane, on the TRAILING
// edge: events inside a busy window are deferred to one read at the end of it, never
// dropped, so the last thing a seat did before going quiet is what the lane shows. The
// idle tick re-projects the LAST snapshot with a fresh clock and costs no RPC at all,
// which is what makes "quiet for 40 s" appear without polling the sidecar for it.

import type { LaneLatest } from "@rennet/protocol";
import type { OrchestrationThread, T3Client } from "./client";
import { LATEST_EVENT_IDLE_AFTER_MS, projectLatestEvent } from "./latest-event";

/** At most four publications a second per lane. */
export const SEAT_PROGRESS_MIN_INTERVAL_MS = 250;

/** How often the projection is re-evaluated against the clock alone (no RPC). */
export const SEAT_PROGRESS_IDLE_TICK_MS = 1_000;

export interface WatchSeatThreadInput {
  readonly client: Pick<T3Client, "subscribeThread" | "readThread">;
  readonly threadId: string;
  /** Stripped from absolute paths so a line reads `src/foo.ts`. */
  readonly repoRoot?: string;
  readonly publish: (latest: LaneLatest) => void;
  readonly now?: () => number;
  readonly minIntervalMs?: number;
  readonly idleTickMs?: number;
  /** Diagnostics only; a dead subscription must never take the seat's turn with it. */
  readonly onError?: (error: unknown) => void;
}

export interface SeatThreadWatch {
  /** Idempotent. Drops the subscription and stops publishing. */
  readonly stop: () => void;
}

/**
 * Hold the thread's subscription and publish its latest event, throttled.
 *
 * Never throws and never rejects: a lane's live line is decoration over the turn, and a
 * broken subscription must not fail the seat that is otherwise working.
 */
export function watchSeatThread(input: WatchSeatThreadInput): SeatThreadWatch {
  const now = input.now ?? Date.now;
  const minIntervalMs = input.minIntervalMs ?? SEAT_PROGRESS_MIN_INTERVAL_MS;
  const idleTickMs = input.idleTickMs ?? SEAT_PROGRESS_IDLE_TICK_MS;
  let stopped = false;
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  // Separate from `lastPublishedAt` on purpose (review finding 5). A re-read that produces
  // the SAME line publishes nothing, so keying the read throttle on the publish time meant
  // every further event in a run of identical events re-read the thread over RPC.
  let lastReadAt = Number.NEGATIVE_INFINITY;
  let lastText: string | undefined;
  let latestThread: OrchestrationThread | undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  let trailing: ReturnType<typeof setTimeout> | undefined;

  const project = (): void => {
    if (stopped || latestThread === undefined) return;
    const at = now();
    if (at - lastPublishedAt < minIntervalMs) return;
    const latest = projectLatestEvent(latestThread, at, {
      ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
      idleAfterMs: LATEST_EVENT_IDLE_AFTER_MS,
    });
    if (latest === undefined) return;
    // A line identical to the one already on the lane is not news; re-emitting it would
    // churn the whole lane snapshot for nothing.
    if (latest.text === lastText) return;
    lastText = latest.text;
    lastPublishedAt = at;
    input.publish(latest);
  };

  const clearTrailing = (): void => {
    if (trailing === undefined) return;
    clearTimeout(trailing);
    trailing = undefined;
  };

  /** One re-read of the thread, then a projection. Never throws. */
  const refresh = async (): Promise<void> => {
    if (stopped) return;
    clearTrailing();
    lastReadAt = now();
    try {
      latestThread = await input.client.readThread(input.threadId);
    } catch (error) {
      if (!stopped) input.onError?.(error);
      return;
    }
    project();
  };

  /**
   * TRAILING EDGE. Events inside the throttle window used to be dropped outright, so the
   * LAST state of a busy window only ever reached the lane because a later event happened
   * to arrive — and a seat that goes quiet right after its busiest moment showed a line
   * from the middle of it. One timer fires one read at the end of the window instead.
   */
  const scheduleTrailing = (delayMs: number): void => {
    if (stopped || trailing !== undefined) return;
    trailing = setTimeout(
      () => {
        trailing = undefined;
        void refresh();
      },
      Math.max(0, delayMs),
    );
    trailing.unref?.();
  };

  const timer = setInterval(project, idleTickMs);
  // A daemon must be able to exit with a seat watch still open.
  timer.unref?.();

  void (async () => {
    try {
      const stream = input.client.subscribeThread(input.threadId);
      const it = stream[Symbol.asyncIterator]();
      iterator = it;
      if (stopped) {
        await it.return?.();
        return;
      }
      for (;;) {
        const next = await it.next();
        if (next.done || stopped) break;
        const item = next.value;
        if (item.kind === "snapshot") {
          latestThread = item.snapshot.thread;
          // The snapshot IS a fresh read, so it opens the read window like one.
          lastReadAt = now();
          project();
          continue;
        }
        // An event does not carry the projection, so seeing one means an RPC re-read. A
        // busy turn emits far more events a second than a lane can usefully show, so the
        // read is throttled — and the window ends with a trailing read rather than with
        // whatever the last event before the window happened to be.
        const due = lastReadAt + minIntervalMs - now();
        if (due > 0) {
          scheduleTrailing(due);
          continue;
        }
        await refresh();
      }
    } catch (error) {
      if (!stopped) input.onError?.(error);
    }
  })();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTrailing();
      void iterator?.return?.();
    },
  };
}
