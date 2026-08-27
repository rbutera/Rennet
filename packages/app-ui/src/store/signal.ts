import type { StateCreator } from "zustand";
import type { RennetState } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// The `signal` slice (C01 §3): the transient attention-signal batching state — the FAB
// (floating action button) flight/pip counters coalesced inside a short window (~80ms),
// so a burst of attention events lands as one animated pip rather than a flicker. The
// coalescing WINDOW itself is owned by an injected-clock batcher at the call site (per the
// dependency standard — no RxJS); this slice holds only the batched counts it commits.
// Transient (no persist). `ponytail:` foundation slice — the flight animation is C-change
// domain; C01 lands the counters + mutators.
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalState {
  /** Pending pips still in flight (mid-animation) toward the FAB. */
  readonly inFlight: number;
  /** Landed pips accumulated on the FAB (the batched attention count). */
  readonly landed: number;
}

export interface SignalSlice {
  readonly signal: SignalState;
  readonly signalActions: {
    /** Commit one coalesced batch of `count` pips into flight. */
    launch(count: number): void;
    /** Land `count` in-flight pips onto the FAB. */
    land(count: number): void;
    /** Clear the landed pips (the reviewer viewed them). */
    clearLanded(): void;
    resetSignal(): void;
  };
}

const initialSignal: SignalState = { inFlight: 0, landed: 0 };

export const createSignalSlice: StateCreator<RennetState, [], [], SignalSlice> = (set) => ({
  signal: initialSignal,
  signalActions: {
    launch: (count) =>
      set((s) => ({ signal: { ...s.signal, inFlight: s.signal.inFlight + count } })),
    land: (count) =>
      set((s) => ({
        signal: {
          inFlight: Math.max(0, s.signal.inFlight - count),
          landed: s.signal.landed + count,
        },
      })),
    clearLanded: () => set((s) => ({ signal: { ...s.signal, landed: 0 } })),
    resetSignal: () => set(() => ({ signal: initialSignal })),
  },
});

// ── Selectors (beside the slice) ─────────────────────────────────────────────
/** True while any pip is mid-flight. DERIVED, not a stored flag. */
export const selectSignalAnimating = (s: RennetState): boolean => s.signal.inFlight > 0;
