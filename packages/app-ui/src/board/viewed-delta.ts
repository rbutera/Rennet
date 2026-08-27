import type { StateCreator } from "zustand";
import type { RennetState } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The `viewedDelta` slice (C05, Reconciliation 6) — a NEW ui-store axis, distinct
// from read-state. `canvas/read-state.ts` (#17) is a pure fold for path read-COVERAGE
// and holds no view state; delta marks are a DIFFERENT axis: a section's round
// `new`/`reworked` badge is UNREAD until the reviewer interacts with it, per section,
// cleared on interaction, and replaced wholesale at the next regeneration.
//
// UI-only, by the schema's own word ("the viewed set that decays the mark is
// UI-only"): not persisted, not on the wire. A reload starts every delta unread again
// — the mark decays with interaction within a session, nothing more.
// ─────────────────────────────────────────────────────────────────────────────

export interface ViewedDeltaState {
  /** Section ids the reviewer has interacted with this session — the gold dot clears
   *  once a section's id lands here. Absent ⇒ still unread (the dot shows). */
  readonly viewedDeltaSections: Readonly<Record<string, true>>;
}

export interface ViewedDeltaSlice {
  readonly viewedDelta: ViewedDeltaState;
  readonly viewedDeltaActions: {
    /** Mark section `sectionId` viewed — clears its delta dot. Idempotent. */
    markDeltaViewed(sectionId: string): void;
  };
}

const initialViewedDelta: ViewedDeltaState = { viewedDeltaSections: {} };

export const createViewedDeltaSlice: StateCreator<RennetState, [], [], ViewedDeltaSlice> = (
  set,
) => ({
  viewedDelta: initialViewedDelta,
  viewedDeltaActions: {
    markDeltaViewed: (sectionId) =>
      set((s) =>
        s.viewedDelta.viewedDeltaSections[sectionId]
          ? s // already viewed — no state change, stable references
          : {
              viewedDelta: {
                viewedDeltaSections: { ...s.viewedDelta.viewedDeltaSections, [sectionId]: true },
              },
            },
      ),
  },
});

// ── Selector (beside the slice) ──────────────────────────────────────────────
/** True once section `sectionId` has been viewed (its delta dot has cleared). */
export const selectDeltaViewed =
  (sectionId: string) =>
  (s: RennetState): boolean =>
    s.viewedDelta.viewedDeltaSections[sectionId] === true;
