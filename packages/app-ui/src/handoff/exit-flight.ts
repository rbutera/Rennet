import { useEffect, useRef } from "react";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The exit-flight batcher (C08 cluster 2, autopsy S8, R50) — the named replacement for
// the spike's `lib/fab-signal.ts` MODULE GLOBAL. That global accumulated the pip COUNT
// from events (the drift the autopsy killed); here the count is derived (`selectExitPipCount`)
// and this batcher owns ONLY the flight GESTURE: it coalesces the burst of stage signals a
// single composite act emits in one tick (a highlight request-change fires several store
// writes at once) into ONE launch, so the FAB flies one bubble, not a flicker. A genuinely
// later signal — an orchestrator reply arriving seconds on — falls outside the window and
// launches on its own.
//
// It is a PLAIN FACTORY a caller instantiates and owns, NOT a shared singleton bus (nothing
// under `handoff/` re-introduces a module-global emitter). The clock is injected so a test
// drives the ~80ms window deterministically — no RxJS (the `signal` slice's documented
// contract). The flight itself (bubble DOM → FAB, then `land`) is the FAB's, watching the
// `signal` slice's `inFlight`; this only decides WHEN a launch fires.
// ─────────────────────────────────────────────────────────────────────────────

/** The batching window: composite acts within it collapse to one flight (spike GESTURE_WINDOW_MS). */
export const GESTURE_WINDOW_MS = 80;

/** The minimal clock the batcher needs — injected so tests advance it by hand. */
export interface FlightClock {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const realClock: FlightClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface FlightBatcher {
  /** Signal one stage gesture. Calls within an open window collapse to one launch. */
  signal(): void;
  /** Cancel any pending window (unmount cleanup). */
  dispose(): void;
}

/**
 * Coalesce stage signals into `launch(1)` calls, one per ~80ms window. The first `signal()`
 * opens the window; further signals inside it are absorbed; the window flush emits a single
 * `launch(1)`. A `signal()` after the window opens a fresh window and launches again — the
 * "a later event pips alone" rule. The launched COUNT is always 1: the pip count is derived,
 * so a gesture flies one bubble regardless of how many writes composed it.
 */
export function createFlightBatcher(
  launch: (count: number) => void,
  clock: FlightClock = realClock,
  windowMs: number = GESTURE_WINDOW_MS,
): FlightBatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    launch(1);
  };
  return {
    signal() {
      if (timer === null) timer = clock.setTimeout(flush, windowMs);
    },
    dispose() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * The call-site hook: a stable batcher bound to the store's `launch`. A staging control fires
 * the real act and then `flight.signal()` in the same handler — the act stages, the signal
 * flies. Seeding never calls this, so seeding never animates (the packet's seeding rule).
 */
export function useFlightBatcher(): FlightBatcher {
  const launch = useRennetStore((s) => s.signalActions.launch);
  const ref = useRef<FlightBatcher | null>(null);
  ref.current ??= createFlightBatcher(launch);
  useEffect(() => () => ref.current?.dispose(), []);
  return ref.current;
}
