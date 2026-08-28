// The hand-off layer (C08, #489) — the review's LEAVING surfaces: the exit FAB + derived pip,
// the ask basket, the mode-dispatched hand-off view, the living draft, and the three exits.
// State is rewritten onto the C01 `review`/`signal` slices (not the spike's module global,
// autopsy S8); the living-draft SOURCE is the one swap `handoff-data.ts` still absorbs (its
// span-rework half is bound to B11's `review.reviseSpan`). See the modules for the doctrine.
//
// Public surface: the FAB (the route mounts it), the hand-off view (the `?view=handoff` branch),
// the mode resolution, and the egress-return / draft types cluster 6's wiring names. The lanes
// (`post-review-lane`, `rounds-lanes`), the basket, the selectors and the data seam stay internal —
// they are reached THROUGH `HandoffView`, never imported past this barrel (trim, no whole-tree re-export).
export { ExitFab, type ExitFabProps } from "./fab";
export { type EntryMode, modeHasExits, resolveEntryMode } from "./handoff-data";
export { HandoffView, type HandoffViewProps } from "./handoff-view";
export type { PostReceipt } from "./post-review-lane";
export type { DraftedPr, PrReceipt } from "./rounds-lanes";
export type { ProposedVerdict } from "./selectors";
