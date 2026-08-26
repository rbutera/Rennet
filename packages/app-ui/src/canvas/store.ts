import type { CanvasAngle } from "@rennet/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { rotateLens, type ZoomState } from "./logic";

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeral view state (R35: "ephemeral view state stays zustand").
//
// This store holds ONLY navigation/presentation state — the active lens, the
// blast-radius overlay toggle, which cohorts are expanded, the zoom path, the
// selection, the cursor anchor (the fixed point), and the colour scheme. It holds
// NO read state: read state is L2 dispositions in the store (coverage), and
// nothing here can mark anything read. That is "collapse ≠ read" enforced by the
// shape of the state, not by a comment.
// ─────────────────────────────────────────────────────────────────────────────

export type Scheme = "dark" | "light";

export interface ViewState {
  angle: CanvasAngle;
  /** The amber blast-radius overlay toggle — paints the active canvas, never a canvas. */
  overlayOn: boolean;
  /** Which cohorts are expanded. Navigation only; never read state. */
  expandedCohorts: Record<string, boolean>;
  zoom: ZoomState;
  selection?: string;
  /** The hunk under the cursor — preserved across lens rotation (the fixed point). */
  cursorAnchor?: string;
  scheme: Scheme;

  setAngle(angle: CanvasAngle): void;
  /** Rotate the lens while keeping the cursor hunk fixed. */
  rotate(dir: 1 | -1): void;
  toggleOverlay(): void;
  toggleCohort(cohortKey: string): void;
  collapseAll(): void;
  setZoom(zoom: ZoomState): void;
  select(elementKey?: string): void;
  setCursor(anchor?: string): void;
  setScheme(scheme: Scheme): void;
  /**
   * Reset the REVIEW-SCOPED view state (lens, zoom, selection, cursor, expanded
   * cohorts, overlay) to the clean roll-up default, PRESERVING the scheme (a global
   * appearance choice, not review state). A lifted, app-lifetime store must call this
   * when the open review changes, so review B never inherits review A's selection —
   * which points at a hunk that does not exist in B.
   */
  resetView(): void;
}

export type ViewStore = ReturnType<typeof createViewStore>;

export function createViewStore(initial?: Partial<ViewState>) {
  return createStore<ViewState>((set) => ({
    angle: initial?.angle ?? "decisions",
    overlayOn: initial?.overlayOn ?? false,
    expandedCohorts: initial?.expandedCohorts ?? {},
    zoom: initial?.zoom ?? { level: "rollup" },
    selection: initial?.selection,
    cursorAnchor: initial?.cursorAnchor,
    scheme: initial?.scheme ?? "dark",

    setAngle: (angle) => set({ angle, zoom: { level: "rollup" } }),
    // The fixed-point rule: rotation changes the lens; the cursor anchor stays put
    // so the caller can re-center on the same hunk (see refocusCursor).
    rotate: (dir) =>
      set((state) => ({ angle: rotateLens(state.angle, dir), zoom: { level: "rollup" } })),
    toggleOverlay: () => set((state) => ({ overlayOn: !state.overlayOn })),
    toggleCohort: (cohortKey) =>
      set((state) => ({
        expandedCohorts: {
          ...state.expandedCohorts,
          [cohortKey]: !state.expandedCohorts[cohortKey],
        },
      })),
    collapseAll: () => set({ expandedCohorts: {} }),
    setZoom: (zoom) => set({ zoom }),
    select: (elementKey) => set({ selection: elementKey }),
    setCursor: (anchor) => set({ cursorAnchor: anchor }),
    setScheme: (scheme) => set({ scheme }),
    // Scheme is deliberately NOT reset — it is a global appearance preference.
    resetView: () =>
      set({
        angle: "decisions",
        overlayOn: false,
        expandedCohorts: {},
        zoom: { level: "rollup" },
        selection: undefined,
        cursorAnchor: undefined,
      }),
  }));
}

/** React binding for a view store (selector-based, like any zustand store). */
export function useViewStore<T>(store: ViewStore, selector: (state: ViewState) => T): T {
  return useStore(store, selector);
}
