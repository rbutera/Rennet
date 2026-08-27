import type { StateCreator } from "zustand";
import type { RennetState } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The `viewedDelta` slice (C05, Reconciliation 6) — a NEW ui-store axis, distinct
// from read-state. `canvas/read-state.ts` (#17) is a pure fold for path read-COVERAGE
// and holds no view state; delta marks are a DIFFERENT axis: a section's round
// `new`/`reworked` badge is UNREAD until the reviewer interacts with it, per section,
// cleared on interaction, and replaced wholesale at the next regeneration.
//
// SCOPED BY BOARD (finding 3): a section ref (`change`, `design`, `tasks`) is reused
// verbatim across generations, so keying the viewed set by the bare ref would carry a
// reviewer's "seen it" from one generation into a same-ref REWORKED section of the
// next — starting it falsely viewed, contradicting "replaced wholesale next round".
// The key is therefore `boardId::ref`: a successor generation is a new board with a new
// `boardId`, so its sections start unviewed with no explicit reset, and a prior
// generation's marks simply key an old board that is no longer on screen.
//
// UI-only, by the schema's own word ("the viewed set that decays the mark is
// UI-only"): not persisted, not on the wire. A reload starts every delta unread again
// — the mark decays with interaction within a session, nothing more.
// ─────────────────────────────────────────────────────────────────────────────

/** The composite viewed-set key: a section ref, scoped to the board it lives on. */
export const deltaKey = (boardId: string, ref: string): string => `${boardId}::${ref}`;

export interface ViewedDeltaState {
  /** `boardId::ref` keys the reviewer has interacted with this session — the gold dot
   *  clears once a section's key lands here. Absent ⇒ still unread (the dot shows). */
  readonly viewedDeltaSections: Readonly<Record<string, true>>;
}

export interface ViewedDeltaSlice {
  readonly viewedDelta: ViewedDeltaState;
  readonly viewedDeltaActions: {
    /** Mark section `ref` on board `boardId` viewed — clears its delta dot. Idempotent. */
    markDeltaViewed(boardId: string, ref: string): void;
  };
}

const initialViewedDelta: ViewedDeltaState = { viewedDeltaSections: {} };

export const createViewedDeltaSlice: StateCreator<RennetState, [], [], ViewedDeltaSlice> = (
  set,
) => ({
  viewedDelta: initialViewedDelta,
  viewedDeltaActions: {
    markDeltaViewed: (boardId, ref) =>
      set((s) => {
        const key = deltaKey(boardId, ref);
        return s.viewedDelta.viewedDeltaSections[key]
          ? s // already viewed — no state change, stable references
          : {
              viewedDelta: {
                viewedDeltaSections: { ...s.viewedDelta.viewedDeltaSections, [key]: true },
              },
            };
      }),
  },
});

// ── Selector (beside the slice) ──────────────────────────────────────────────
/** True once section `ref` on board `boardId` has been viewed (its dot has cleared). */
export const selectDeltaViewed =
  (boardId: string, ref: string) =>
  (s: RennetState): boolean =>
    s.viewedDelta.viewedDeltaSections[deltaKey(boardId, ref)] === true;
