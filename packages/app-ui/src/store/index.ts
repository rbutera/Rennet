import { create } from "zustand";
import { createReviewSlice, type ReviewSlice } from "./review";
import { createRunSlice, type RunSlice } from "./run";
import { createSignalSlice, type SignalSlice } from "./signal";
import { createUiSlice, type UiSlice } from "./ui";

// ─────────────────────────────────────────────────────────────────────────────
// The Rennet renderer store (C01 §3): ONE zustand store, four slices — ui / review /
// run / signal. NO persist middleware: a reload restores LOCATION from the URL and
// resets interaction clean. NO `sidebar` slice: the host/project/session tree is a
// server projection read through the data seam, and its mutations are commands.
//
// DELETE-ON-SIGHT: no field here may duplicate anything computable from the projection
// cache plus other fields. Counts, tallies, highlights, and "is anything running" are
// SELECTORS (beside their slice), never stored fields. A new field that a selector could
// derive is a bug — delete it and add the selector. This is the discipline that keeps the
// store from becoming the spike's god-state (autopsy S3).
//
// `createRennetStore()` builds a fresh, isolated store — a test uses it to prove reload
// semantics (a fresh create is clean; nothing is rehydrated). `useRennetStore` is the app
// singleton.
// ─────────────────────────────────────────────────────────────────────────────

export type RennetState = UiSlice & ReviewSlice & RunSlice & SignalSlice;

export const createRennetStore = () =>
  create<RennetState>()((...args) => ({
    ...createUiSlice(...args),
    ...createReviewSlice(...args),
    ...createRunSlice(...args),
    ...createSignalSlice(...args),
  }));

/** The app-singleton store. */
export const useRennetStore = createRennetStore();

export type {
  DispositionKind,
  QuoteMessage,
  QuoteThread,
  ReviewSlice,
  ReviewState,
  StagedAsk,
} from "./review";
export {
  createReviewSlice,
  selectCodeComment,
  selectCodeComments,
  selectStagedAsk,
  selectStagedAskCount,
} from "./review";
export type { LaneStatus, RunSlice, RunState } from "./run";
export { createRunSlice, selectRoundRunning, selectRunningLaneCount } from "./run";
export type { SignalSlice, SignalState } from "./signal";
export { createSignalSlice, selectSignalAnimating } from "./signal";
export type { CommandMenuMode, UiSlice, UiState } from "./ui";
export {
  createUiSlice,
  selectDialogOpen,
  selectFolded,
  selectTopDialog,
} from "./ui";
