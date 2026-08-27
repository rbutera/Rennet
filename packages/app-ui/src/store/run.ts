import type { StateCreator } from "zustand";
import type { RennetState } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// The `run` slice (C01 §3): live-run interaction state — round progress, the greeting
// arm, and per-lane regeneration status. Transient (no persist): a reload resets the
// run view and re-reads live state through the data seam. `ponytail:` foundation slice —
// the round/lane shapes are C-change (C7/C8) domain; C01 lands the owned fields, the
// core mutators, and a derived selector.
// ─────────────────────────────────────────────────────────────────────────────

/** A regeneration lane's live status. */
export type LaneStatus = "idle" | "running" | "done" | "failed";

export interface RunState {
  /** The live round's progress fraction 0..1, or null when no round is running. */
  readonly roundProgress: number | null;
  /** The greeting is armed (the run view's first-open affordance). */
  readonly greetingArmed: boolean;
  /** Per-lane regeneration status, keyed by lane id. */
  readonly laneStatus: Readonly<Record<string, LaneStatus>>;
}

export interface RunSlice {
  readonly run: RunState;
  readonly runActions: {
    setRoundProgress(progress: number | null): void;
    armGreeting(armed: boolean): void;
    setLaneStatus(laneId: string, status: LaneStatus): void;
    resetRun(): void;
  };
}

const initialRun: RunState = {
  roundProgress: null,
  greetingArmed: false,
  laneStatus: {},
};

export const createRunSlice: StateCreator<RennetState, [], [], RunSlice> = (set) => ({
  run: initialRun,
  runActions: {
    setRoundProgress: (progress) => set((s) => ({ run: { ...s.run, roundProgress: progress } })),
    armGreeting: (armed) => set((s) => ({ run: { ...s.run, greetingArmed: armed } })),
    setLaneStatus: (laneId, status) =>
      set((s) => ({ run: { ...s.run, laneStatus: { ...s.run.laneStatus, [laneId]: status } } })),
    resetRun: () => set(() => ({ run: initialRun })),
  },
});

// ── Selectors (beside the slice) ─────────────────────────────────────────────
/** True while any round is in progress. DERIVED from `roundProgress`, not a stored flag. */
export const selectRoundRunning = (s: RennetState): boolean => s.run.roundProgress !== null;
/** How many lanes are currently regenerating. DERIVED — never a stored count. */
export const selectRunningLaneCount = (s: RennetState): number =>
  Object.values(s.run.laneStatus).filter((status) => status === "running").length;
